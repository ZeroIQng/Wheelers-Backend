import { createHash, randomInt, timingSafeEqual } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import { userClient } from '@wheleers/db';
import type { RedisClient } from '../redis/client';
import { verifyLocalAccessToken } from '../auth/local';
import { getString, isRecord } from '../utils/object';
import { readJsonBody, sendJson } from './utils';
import { logActivity } from '../analytics/log-activity';

const PHONE_OTP_KEY_PREFIX = 'auth:phone-otp:';
const PHONE_OTP_LENGTH = 6;
const PHONE_OTP_TTL_SECONDS = 300;

export interface PhoneRouteDeps {
  jwtSecret: string;
  redisClient: RedisClient;
  // Meta WhatsApp Cloud API — the same credentials the bot replies with.
  metaAccessToken?: string;
  metaPhoneNumberId?: string;
  // Approved AUTHENTICATION template. Without it a plain text is sent, which
  // Meta only delivers inside the 24h window after the rider last messaged.
  metaOtpTemplateName?: string;
  metaOtpTemplateLanguage?: string;
  phoneOtpTtlSeconds?: number;
}

interface StoredPhoneOtp {
  codeHash: string;
  phone: string;
}

function extractBearerToken(value: string | undefined): string | undefined {
  if (!value) return undefined;

  const [scheme, token] = value.split(' ');
  if (!scheme || !token || scheme.toLowerCase() !== 'bearer') {
    return undefined;
  }

  return token;
}

async function authenticateHttpUser(
  req: IncomingMessage,
  jwtSecret: string,
): Promise<NonNullable<Awaited<ReturnType<typeof userClient.findByPrivyDid>>>> {
  const authorization =
    typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined;
  const token = extractBearerToken(authorization);

  if (!token) {
    throw new Error('Authorization bearer token is required');
  }

  const localToken = verifyLocalAccessToken(token, jwtSecret);
  return await userClient.findById(localToken.sub);
}

export function normalizePhoneNumber(value: string): string {
  const trimmed = value.trim();
  if (!/^\+[1-9]\d{7,14}$/.test(trimmed)) {
    throw new Error('phone must be a valid E.164 number, for example +2348012345678');
  }

  return trimmed;
}

export function hashOtp(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

export function buildOtpCode(): string {
  const max = 10 ** PHONE_OTP_LENGTH;
  return String(randomInt(0, max)).padStart(PHONE_OTP_LENGTH, '0');
}

function buildOtpRedisKey(userId: string): string {
  return `${PHONE_OTP_KEY_PREFIX}${userId}`;
}

export function timingSafeStringEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

function hasConfiguredMeta(deps: PhoneRouteDeps): deps is PhoneRouteDeps & {
  metaAccessToken: string;
  metaPhoneNumberId: string;
} {
  return Boolean(deps.metaAccessToken && deps.metaPhoneNumberId);
}

export function hasOtpChannel(deps: PhoneRouteDeps): boolean {
  return hasConfiguredMeta(deps);
}

const OTP_NOT_CONFIGURED =
  'Phone code delivery is not configured. Set META_ACCESS_TOKEN and META_PHONE_NUMBER_ID (WhatsApp Cloud API).';

function describeMetaError(status: number, payload: string): string {
  try {
    const parsed = JSON.parse(payload) as {
      error?: { message?: string; code?: number; error_data?: { details?: string } };
    };
    const code = parsed.error?.code;
    const details = parsed.error?.error_data?.details ?? parsed.error?.message ?? payload;
    if (code === 131047 || code === 131026) {
      return `WhatsApp refused the message (${code}: ${details}). Free-form texts only reach riders who messaged the bot in the last 24h — configure an approved authentication template (META_OTP_TEMPLATE_NAME).`;
    }
    return `WhatsApp send failed (${status}${code ? `, code ${code}` : ''}): ${details}`;
  } catch {
    return `WhatsApp send failed (${status}): ${payload}`;
  }
}

/**
 * Deliver a code over the Meta WhatsApp Cloud API. With an approved
 * AUTHENTICATION template the code goes in the body and on the copy-code
 * button (Meta's required shape); otherwise a plain text message.
 */
export async function sendPhoneOtpMessage(
  deps: PhoneRouteDeps,
  phone: string,
  body: string,
  code: string,
): Promise<'whatsapp'> {
  if (!hasConfiguredMeta(deps)) {
    throw new Error(OTP_NOT_CONFIGURED);
  }

  const endpoint = `https://graph.facebook.com/v21.0/${deps.metaPhoneNumberId}/messages`;
  const recipient = phone.replace(/^\+/, '');

  const message = deps.metaOtpTemplateName
    ? {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: recipient,
        type: 'template',
        template: {
          name: deps.metaOtpTemplateName,
          language: { code: deps.metaOtpTemplateLanguage ?? 'en_US' },
          components: [
            { type: 'body', parameters: [{ type: 'text', text: code }] },
            { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] },
          ],
        },
      }
    : {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: recipient,
        type: 'text',
        text: { body },
      };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${deps.metaAccessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(message),
  });

  if (!response.ok) {
    throw new Error(describeMetaError(response.status, await response.text()));
  }

  return 'whatsapp';
}

async function readStoredPhoneOtp(
  redisClient: RedisClient,
  userId: string,
): Promise<StoredPhoneOtp | null> {
  const raw = await redisClient.get(buildOtpRedisKey(userId));
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<StoredPhoneOtp>;
    if (typeof parsed.codeHash !== 'string' || typeof parsed.phone !== 'string') {
      return null;
    }

    return {
      codeHash: parsed.codeHash,
      phone: parsed.phone,
    };
  } catch {
    return null;
  }
}

export async function handleSendPhoneOtpRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: PhoneRouteDeps,
): Promise<void> {
  try {
    const rawBody = await readJsonBody(req);
    if (!isRecord(rawBody)) {
      sendJson(res, 400, { error: 'Body must be a JSON object' });
      return;
    }

    const user = await authenticateHttpUser(req, deps.jwtSecret);
    const rawPhone = getString(rawBody, 'phone');
    if (!rawPhone) {
      sendJson(res, 400, { error: 'phone is required' });
      return;
    }

    if (!hasOtpChannel(deps)) {
      sendJson(res, 500, { error: OTP_NOT_CONFIGURED });
      return;
    }

    const phone = normalizePhoneNumber(rawPhone);
    const code = buildOtpCode();
    const codeHash = hashOtp(code);
    const ttlSeconds = deps.phoneOtpTtlSeconds ?? PHONE_OTP_TTL_SECONDS;

    const redisKey = buildOtpRedisKey(user.id);
    const messageBody = `Your Wheelers verification code is ${code}. It expires in ${Math.max(1, Math.floor(ttlSeconds / 60))} minute(s).`;

    await deps.redisClient.set(
      redisKey,
      JSON.stringify({
        codeHash,
        phone,
      } satisfies StoredPhoneOtp),
      ttlSeconds,
    );

    try {
      const channel = await sendPhoneOtpMessage(deps, phone, messageBody, code);
      sendJson(res, 200, {
        sent: true,
        channel,
        phone,
        expiresInSeconds: ttlSeconds,
      });
    } catch (error) {
      await deps.redisClient.del(redisKey);
      throw error;
    }
  } catch (error) {
    sendJson(res, 400, {
      error: error instanceof Error ? error.message : 'Could not send phone verification code',
    });
  }
}

export async function handleVerifyPhoneOtpRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: PhoneRouteDeps,
): Promise<void> {
  try {
    const rawBody = await readJsonBody(req);
    if (!isRecord(rawBody)) {
      sendJson(res, 400, { error: 'Body must be a JSON object' });
      return;
    }

    const user = await authenticateHttpUser(req, deps.jwtSecret);
    const code = getString(rawBody, 'code')?.trim();
    if (!code) {
      sendJson(res, 400, { error: 'code is required' });
      return;
    }

    const stored = await readStoredPhoneOtp(deps.redisClient, user.id);
    if (!stored) {
      sendJson(res, 400, { error: 'No active phone verification code found. Request a new code.' });
      return;
    }

    const providedHash = hashOtp(code);
    if (!timingSafeStringEquals(providedHash, stored.codeHash)) {
      sendJson(res, 400, { error: 'Invalid verification code' });
      return;
    }

    const updatedUser = await userClient.updateAuthIdentity(user.id, {
      phone: stored.phone,
    });

    await deps.redisClient.del(buildOtpRedisKey(user.id));

    logActivity({ userId: user.id, eventType: 'phone_verified', metadata: {} });

    sendJson(res, 200, {
      verified: true,
      user: {
        id: updatedUser.id,
        privyDid: updatedUser.privyDid,
        email: updatedUser.email,
        role: updatedUser.role,
        name: updatedUser.name,
        phone: updatedUser.phone,
      },
    });
  } catch (error) {
    sendJson(res, 400, {
      error: error instanceof Error ? error.message : 'Could not verify phone code',
    });
  }
}
