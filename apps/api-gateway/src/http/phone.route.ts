import { createHash, randomInt, timingSafeEqual } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import { userClient } from '@wheleers/db';
import type { RedisClient } from '../redis/client';
import { verifyLocalAccessToken } from '../auth/local';
import { verifyPrivyAccessToken } from '../auth/privy';
import { getString, isRecord } from '../utils/object';
import { readJsonBody, sendJson } from './utils';

const PHONE_OTP_KEY_PREFIX = 'auth:phone-otp:';
const PHONE_OTP_LENGTH = 6;
const PHONE_OTP_TTL_SECONDS = 300;

interface PhoneRouteDeps {
  privyAppId: string;
  privyVerificationKey: string;
  redisClient: RedisClient;
  whatsappGatewayUrl?: string;
  whatsappGatewayToken?: string;
  twilioAccountSid?: string;
  twilioAuthToken?: string;
  twilioFromNumber?: string;
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
  appId: string,
  verificationKey: string,
): Promise<NonNullable<Awaited<ReturnType<typeof userClient.findByPrivyDid>>>> {
  const authorization =
    typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined;
  const token = extractBearerToken(authorization);

  if (!token) {
    throw new Error('Authorization bearer token is required');
  }

  if (process.env.JWT_SECRET) {
    try {
      const localToken = verifyLocalAccessToken(token, process.env.JWT_SECRET);
      return await userClient.findById(localToken.sub);
    } catch (error) {
      if (error instanceof Error && error.message.includes('Local auth token')) {
        // Fall through to Privy verification so legacy clients keep working.
      } else {
        throw error;
      }
    }
  }

  const verifiedToken = verifyPrivyAccessToken({
    accessToken: token,
    appId,
    verificationKey,
  });

  const user = await userClient.findByPrivyDid(verifiedToken.privyDid);
  if (!user) {
    throw new Error('User not registered. Call POST /auth/privy first.');
  }

  return user;
}

function normalizePhoneNumber(value: string): string {
  const trimmed = value.trim();
  if (!/^\+[1-9]\d{7,14}$/.test(trimmed)) {
    throw new Error('phone must be a valid E.164 number, for example +2348012345678');
  }

  return trimmed;
}

function hashOtp(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

function buildOtpCode(): string {
  const max = 10 ** PHONE_OTP_LENGTH;
  return String(randomInt(0, max)).padStart(PHONE_OTP_LENGTH, '0');
}

function buildOtpRedisKey(userId: string): string {
  return `${PHONE_OTP_KEY_PREFIX}${userId}`;
}

function timingSafeStringEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

async function sendTwilioSms(params: {
  accountSid: string;
  authToken: string;
  fromNumber: string;
  toNumber: string;
  body: string;
}): Promise<void> {
  const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(params.accountSid)}/Messages.json`;
  const authHeader = Buffer.from(`${params.accountSid}:${params.authToken}`, 'utf8').toString('base64');
  const form = new URLSearchParams({
    To: params.toNumber,
    From: params.fromNumber,
    Body: params.body,
  });

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Basic ${authHeader}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
  });

  if (response.ok) {
    return;
  }

  const payload = await response.text();
  throw new Error(`Twilio SMS send failed (${response.status}): ${payload}`);
}

async function sendWhatsappTextMessage(params: {
  gatewayUrl: string;
  gatewayToken: string;
  toNumber: string;
  body: string;
}): Promise<void> {
  const endpoint = new URL('/messages/text', params.gatewayUrl).toString();
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${params.gatewayToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      phone: params.toNumber,
      body: params.body,
    }),
  });

  if (response.ok) {
    return;
  }

  const payload = await response.text();
  throw new Error(`WhatsApp gateway send failed (${response.status}): ${payload}`);
}

function hasConfiguredWhatsappGateway(deps: PhoneRouteDeps): deps is PhoneRouteDeps & {
  whatsappGatewayUrl: string;
  whatsappGatewayToken: string;
} {
  return Boolean(deps.whatsappGatewayUrl && deps.whatsappGatewayToken);
}

function hasConfiguredTwilio(deps: PhoneRouteDeps): deps is PhoneRouteDeps & {
  twilioAccountSid: string;
  twilioAuthToken: string;
  twilioFromNumber: string;
} {
  return Boolean(deps.twilioAccountSid && deps.twilioAuthToken && deps.twilioFromNumber);
}

async function sendPhoneOtpMessage(
  deps: PhoneRouteDeps,
  phone: string,
  body: string,
): Promise<'whatsapp' | 'sms'> {
  if (hasConfiguredWhatsappGateway(deps)) {
    await sendWhatsappTextMessage({
      gatewayUrl: deps.whatsappGatewayUrl,
      gatewayToken: deps.whatsappGatewayToken,
      toNumber: phone,
      body,
    });
    return 'whatsapp';
  }

  if (hasConfiguredTwilio(deps)) {
    await sendTwilioSms({
      accountSid: deps.twilioAccountSid,
      authToken: deps.twilioAuthToken,
      fromNumber: deps.twilioFromNumber,
      toNumber: phone,
      body,
    });
    return 'sms';
  }

  throw new Error(
    'Phone OTP delivery is not configured. Set WHATSAPP_GATEWAY_URL and WHATSAPP_GATEWAY_TOKEN, or restore the legacy Twilio credentials.',
  );
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

    const user = await authenticateHttpUser(req, deps.privyAppId, deps.privyVerificationKey);
    const rawPhone = getString(rawBody, 'phone');
    if (!rawPhone) {
      sendJson(res, 400, { error: 'phone is required' });
      return;
    }

    const hasWhatsappGateway =
      Boolean(deps.whatsappGatewayUrl) && Boolean(deps.whatsappGatewayToken);
    const hasTwilio =
      Boolean(deps.twilioAccountSid) &&
      Boolean(deps.twilioAuthToken) &&
      Boolean(deps.twilioFromNumber);

    if (
      (Boolean(deps.whatsappGatewayUrl) && !deps.whatsappGatewayToken) ||
      (!deps.whatsappGatewayUrl && Boolean(deps.whatsappGatewayToken))
    ) {
      sendJson(res, 500, {
        error: 'WhatsApp gateway config is incomplete. Set both WHATSAPP_GATEWAY_URL and WHATSAPP_GATEWAY_TOKEN.',
      });
      return;
    }

    if (!hasWhatsappGateway && !hasTwilio) {
      sendJson(res, 500, {
        error: 'Phone OTP delivery is not configured. Set WHATSAPP_GATEWAY_URL and WHATSAPP_GATEWAY_TOKEN.',
      });
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
      const channel = await sendPhoneOtpMessage(deps, phone, messageBody);
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

    const user = await authenticateHttpUser(req, deps.privyAppId, deps.privyVerificationKey);
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

    sendJson(res, 200, {
      verified: true,
      user: {
        id: updatedUser.id,
        privyDid: updatedUser.privyDid,
        walletAddress: updatedUser.walletAddress,
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
