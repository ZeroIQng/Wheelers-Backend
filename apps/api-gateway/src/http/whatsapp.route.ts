import { createHmac, timingSafeEqual } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import { userClient } from '@wheleers/db';
import type { PouchLiquifiaClient } from '@wheleers/pouch-client';
import type { GatewayPublisher } from '../websocket/publisher';
import { createLocalAccessToken } from '../auth/local';
import { onboardWhatsappUser } from '../onboarding/user-onboarding';
import {
  appendWhatsappConversation,
  getWhatsappConversation,
} from '../LLM/conversation-store';
import { WhatsappBotService } from '../LLM/whatsapp-bot.service';
import type { RedisClient } from '../redis/client';
import { readRawBody, sendJson } from './utils';

interface TwilioWhatsappRouteDeps {
  jwtSecret: string;
  publisher: GatewayPublisher;
  pouchLiquifiaClient: PouchLiquifiaClient;
  redisClient: RedisClient;
  twilioAccountSid?: string;
  twilioAuthToken?: string;
  twilioWhatsappNumber?: string;
  twilioKycContentSid?: string;
  groqApiKey?: string;
  groqModel: string;
  groqTimeoutMs: number;
  appBaseUrl?: string;
}

function getHeaderValue(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name.toLowerCase()];
  return typeof value === 'string' ? value : null;
}

function getForwardedProto(req: IncomingMessage): string | null {
  const value = getHeaderValue(req, 'x-forwarded-proto');
  return value?.split(',')[0]?.trim() || null;
}

function getWebhookUrlCandidates(req: IncomingMessage): string[] {
  const host = getHeaderValue(req, 'x-forwarded-host') ?? getHeaderValue(req, 'host');
  if (!host) {
    return [];
  }

  const pathname = req.url ?? '/';
  const proto = getForwardedProto(req) ?? 'https';
  const protocols = proto === 'https' ? ['https', 'http'] : [proto, 'https'];
  return [...new Set(protocols)].map((protocol) => `${protocol}://${host}${pathname}`);
}

function buildTwilioSignatureBase(url: string, params: URLSearchParams): string {
  const pairs: Array<[string, string]> = [];
  for (const key of new Set(params.keys())) {
    for (const value of params.getAll(key)) {
      pairs.push([key, value]);
    }
  }

  pairs.sort(([leftKey, leftValue], [rightKey, rightValue]) => {
    const keyCompare = leftKey.localeCompare(rightKey);
    return keyCompare === 0 ? leftValue.localeCompare(rightValue) : keyCompare;
  });

  return pairs.reduce((base, [key, value]) => `${base}${key}${value}`, url);
}

function isEqualSignature(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function isValidTwilioSignature(
  req: IncomingMessage,
  params: URLSearchParams,
  authToken: string | undefined,
): boolean {
  if (!authToken) {
    return true;
  }

  const provided = getHeaderValue(req, 'x-twilio-signature');
  if (!provided) {
    return false;
  }

  return getWebhookUrlCandidates(req).some((url) => {
    const expected = createHmac('sha1', authToken)
      .update(buildTwilioSignatureBase(url, params))
      .digest('base64');

    return isEqualSignature(provided, expected);
  });
}

function normalizeWhatsappPhone(value: string | null): string | null {
  const normalized = value?.trim().replace(/^whatsapp:/i, '');
  if (!normalized || !/^\+[1-9]\d{6,14}$/.test(normalized)) {
    return null;
  }

  return normalized;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function sendTwilioContentMessage(params: {
  accountSid: string;
  authToken: string;
  from: string;
  to: string;
  contentSid: string;
  contentVariables: Record<string, string>;
}): Promise<void> {
  const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(params.accountSid)}/Messages.json`;
  const authHeader = Buffer.from(`${params.accountSid}:${params.authToken}`, 'utf8').toString('base64');
  const form = new URLSearchParams({
    To: params.to,
    From: params.from,
    ContentSid: params.contentSid,
    ContentVariables: JSON.stringify(params.contentVariables),
  });

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Basic ${authHeader}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
  });

  if (!response.ok) {
    const payload = await response.text();
    console.error('[whatsapp] Content template send failed', { status: response.status, payload });
  }
}

function sendTwiml(res: ServerResponse, message: string): void {
  const body = `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(message)}</Message></Response>`;
  res.statusCode = 200;
  res.setHeader('content-type', 'text/xml; charset=utf-8');
  res.setHeader('content-length', Buffer.byteLength(body));
  res.end(body);
}

function sendEmptyTwiml(res: ServerResponse): void {
  const body = '<?xml version="1.0" encoding="UTF-8"?><Response/>';
  res.statusCode = 200;
  res.setHeader('content-type', 'text/xml; charset=utf-8');
  res.setHeader('content-length', Buffer.byteLength(body));
  res.end(body);
}

export async function handleTwilioWhatsappWebhookRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: TwilioWhatsappRouteDeps,
): Promise<void> {
  try {
    const rawBody = await readRawBody(req);
    const params = new URLSearchParams(rawBody.toString('utf8'));

    if (!isValidTwilioSignature(req, params, deps.twilioAuthToken)) {
      sendJson(res, 403, { error: 'Invalid Twilio signature' });
      return;
    }

    const phone = normalizeWhatsappPhone(params.get('From'));
    if (!phone) {
      sendJson(res, 400, { error: 'Missing valid WhatsApp sender' });
      return;
    }

    const profileName = params.get('ProfileName') ?? undefined;
    const incomingMessage = params.get('Body')?.trim() ?? '';
    const user = await onboardWhatsappUser({
      phone,
      profileName,
      deps: {
        jwtSecret: deps.jwtSecret,
        publisher: deps.publisher,
        pouchLiquifiaClient: deps.pouchLiquifiaClient,
      },
    });

    // Send KYC button template once for brand-new users (non-blocking)
    if (user.created) {
      const freshUser = await userClient.findById(user.id);
      const isVerified = String(freshUser.riderKycStatus ?? 'NONE') === 'VERIFIED';
      const canSendButtonTemplate = Boolean(
        !isVerified &&
        deps.twilioAccountSid &&
        deps.twilioAuthToken &&
        deps.twilioWhatsappNumber &&
        deps.twilioKycContentSid &&
        deps.appBaseUrl,
      );

      if (canSendButtonTemplate) {
        const token = createLocalAccessToken(user.id, deps.jwtSecret);
        const kycPath = `widget/index.html?token=${token}&apiBase=${deps.appBaseUrl}`;
        const displayName = freshUser.name ?? profileName ?? phone;
        const first = displayName.trim().split(/\s+/)[0] ?? displayName;

        // Fire-and-forget — don't block the AI reply
        sendTwilioContentMessage({
          accountSid: deps.twilioAccountSid!,
          authToken: deps.twilioAuthToken!,
          from: `whatsapp:${deps.twilioWhatsappNumber}`,
          to: `whatsapp:${phone}`,
          contentSid: deps.twilioKycContentSid!,
          contentVariables: { '1': first, '2': kycPath },
        }).catch((err) => console.warn('[whatsapp] KYC button send failed', err));
      }
    }

    // AI response for all users
    const recentMessages = await getWhatsappConversation(deps.redisClient, phone);
    const bot = new WhatsappBotService({
      apiKey: deps.groqApiKey,
      model: deps.groqModel,
      timeoutMs: deps.groqTimeoutMs,
      jwtSecret: deps.jwtSecret,
      appBaseUrl: deps.appBaseUrl,
    });
    const reply = await bot.generateReply({
      userId: user.id,
      phone,
      profileName,
      incomingMessage,
      isNewUser: user.created,
      recentMessages,
    });

    await appendWhatsappConversation(deps.redisClient, phone, [
      { role: 'user', content: incomingMessage || '[empty message]' },
      { role: 'assistant', content: reply },
    ]);

    sendTwiml(res, reply);
  } catch (error) {
    console.error('[whatsapp] webhook handling failed', error);
    sendTwiml(
      res,
      'Sorry, Wheelers could not process your message right now. Please try again shortly.',
    );
  }
}
