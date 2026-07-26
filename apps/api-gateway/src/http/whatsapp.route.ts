import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import {
  driverClient,
  walletClient,
  virtualAccountClient,
  withdrawalClient,
} from '@wheleers/db';
import { GoogleMapsRoutePlanner, calculateRideFees } from '@wheleers/config';
import {
  RideRequestedEvent,
  RideCancelledEvent,
  RideOfferAcceptedEvent,
} from '@wheleers/kafka-schemas';
import type { PayoutCreatedEvent } from '@wheleers/kafka-schemas';
import type { PouchBankAccount, PouchLiquifiaClient } from '@wheleers/pouch-client';
import type { GatewayPublisher } from '../websocket/publisher';
import { onboardWhatsappUser } from '../onboarding/user-onboarding';
import {
  appendWhatsappConversation,
  getWhatsappConversation,
} from '../LLM/conversation-store';
import { WhatsappBotService } from '../LLM/whatsapp-bot.service';
import { GroqClient } from '../LLM/groq.client';
import { parseRideIntent } from '../LLM/ride-intent-parser';
import { geocodeAddress, reverseGeocode } from '../LLM/geocoding';
import {
  storeWhatsappRide,
  setActiveRide,
  getActiveRide,
  clearActiveRide,
  setPhoneLookup,
  cleanupRideKeys,
  setPendingLocation,
  getPendingLocation,
  clearPendingLocation,
  setBookingStage,
  getBookingStage,
  clearBookingStage,
  getBids,
  getLastBatch,
  storeLastBatch,
  setRideState,
  getRideState,
  getRideMeta,
  storeAcceptedBid,
  storePendingRoute,
  getPendingRoute,
  clearPendingRoute,
  storePendingAccept,
  getPendingAccept,
  clearPendingAccept,
  storePendingWhatsappWithdrawal,
  getPendingWhatsappWithdrawal,
  clearPendingWhatsappWithdrawal,
} from '../whatsapp-flows/bid-state';
import type { WhatsappBid } from '../whatsapp-flows/bid-state';
import {
  formatBidList,
} from '../whatsapp-flows/whatsapp-notifier';
import type { DriverKycStorage } from '../storage/driver-kyc-storage';
import type { RedisClient } from '../redis/client';
import { readRawBody, sendJson } from './utils';

export interface MetaWhatsappRouteDeps {
  jwtSecret: string;
  publisher: GatewayPublisher;
  pouchLiquifiaClient: PouchLiquifiaClient;
  redisClient: RedisClient;
  routePlanner: GoogleMapsRoutePlanner;
  googleMapsApiKey: string;
  metaAccessToken?: string;
  metaPhoneNumberId?: string;
  metaAppSecret?: string;
  metaWebhookVerifyToken?: string;
  groqApiKey?: string;
  groqModel: string;
  groqTimeoutMs: number;
  appBaseUrl?: string;
  driverKycStorage?: DriverKycStorage;
}

/* ─── Meta Cloud API helpers ─── */

function getHeaderValue(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name.toLowerCase()];
  return typeof value === 'string' ? value : null;
}

function isValidMetaSignature(
  rawBody: Buffer,
  signature: string | null,
  appSecret: string | undefined,
): boolean {
  if (!appSecret) return true; // skip validation if no secret configured
  if (!signature) return false;

  // Meta sends: sha256=<hex>
  const expectedPrefix = 'sha256=';
  if (!signature.startsWith(expectedPrefix)) return false;

  const providedHash = signature.slice(expectedPrefix.length);
  const computedHash = createHmac('sha256', appSecret)
    .update(rawBody)
    .digest('hex');

  const left = Buffer.from(providedHash, 'utf8');
  const right = Buffer.from(computedHash, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

function normalizeMetaPhone(value: string | undefined): string | null {
  if (!value) return null;
  // Meta sends phone without '+', e.g. "2349012345678"
  const withPlus = value.startsWith('+') ? value : `+${value}`;
  if (!/^\+[1-9]\d{6,14}$/.test(withPlus)) return null;
  return withPlus;
}

async function sendMetaReply(
  deps: MetaWhatsappRouteDeps,
  to: string,
  message: string,
): Promise<void> {
  if (!deps.metaAccessToken || !deps.metaPhoneNumberId) {
    console.warn('[whatsapp] Cannot send reply — META_ACCESS_TOKEN or META_PHONE_NUMBER_ID not configured');
    return;
  }

  const recipient = to.replace(/^\+/, '');
  const endpoint = `https://graph.facebook.com/v21.0/${deps.metaPhoneNumberId}/messages`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${deps.metaAccessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: recipient,
      type: 'text',
      text: { body: message },
    }),
  });

  if (!response.ok) {
    const payload = await response.text();
    console.error('[whatsapp] Meta reply failed', { status: response.status, payload });
  }
}

async function sendMetaImageMessage(
  deps: MetaWhatsappRouteDeps,
  to: string,
  imageUrl: string,
  caption?: string,
): Promise<void> {
  if (!deps.metaAccessToken || !deps.metaPhoneNumberId) return;

  const recipient = to.replace(/^\+/, '');
  const endpoint = `https://graph.facebook.com/v21.0/${deps.metaPhoneNumberId}/messages`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${deps.metaAccessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: recipient,
      type: 'image',
      image: { link: imageUrl, ...(caption ? { caption } : {}) },
    }),
  });

  if (!response.ok) {
    const payload = await response.text();
    console.error('[whatsapp] Meta image send failed', { status: response.status, payload });
  }
}

function sendOk(res: ServerResponse): void {
  res.statusCode = 200;
  res.setHeader('content-type', 'text/plain');
  res.end('OK');
}

/* ─── Webhook verification (GET) ─── */

export function handleMetaWhatsappVerify(
  req: IncomingMessage,
  res: ServerResponse,
  deps: MetaWhatsappRouteDeps,
): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');

  console.info('[whatsapp] Verify attempt', { mode, token: token?.slice(0, 10), expected: deps.metaWebhookVerifyToken?.slice(0, 10) });
  if (mode === 'subscribe' && token === deps.metaWebhookVerifyToken) {
    console.info('[whatsapp] Webhook verified');
    res.statusCode = 200;
    res.setHeader('content-type', 'text/plain');
    res.end(challenge ?? '');
    return;
  }

  sendJson(res, 403, { error: 'Verification failed' });
}

/* ─── Extract message from Meta webhook payload ─── */

interface MetaMessageInfo {
  messageId: string;
  phone: string;
  profileName?: string;
  messageBody: string;
  isLocation: boolean;
  locationLat?: number;
  locationLng?: number;
}

function extractMetaMessage(body: unknown): MetaMessageInfo | null {
  const payload = body as Record<string, unknown>;
  if (payload.object !== 'whatsapp_business_account') return null;

  const entries = payload.entry as Array<Record<string, unknown>> | undefined;
  if (!entries?.length) return null;

  for (const entry of entries) {
    const changes = entry.changes as Array<Record<string, unknown>> | undefined;
    if (!changes?.length) continue;

    for (const change of changes) {
      const value = change.value as Record<string, unknown> | undefined;
      if (!value) continue;

      const messages = value.messages as Array<Record<string, unknown>> | undefined;
      if (!messages?.length) continue;

      const msg = messages[0];
      const msgId = msg.id as string | undefined;
      const from = msg.from as string | undefined;
      const phone = normalizeMetaPhone(from);
      if (!phone) continue;

      // Get profile name from contacts array
      const contacts = value.contacts as Array<Record<string, unknown>> | undefined;
      const profileName = contacts?.[0]?.profile
        ? (contacts[0].profile as Record<string, unknown>).name as string | undefined
        : undefined;

      const wamid = msgId ?? '';

      // Handle location messages
      if (msg.type === 'location') {
        const location = msg.location as Record<string, unknown> | undefined;
        const lat = Number(location?.latitude);
        const lng = Number(location?.longitude);
        return {
          messageId: wamid,
          phone,
          profileName,
          messageBody: `[Location: ${lat},${lng}]`,
          isLocation: true,
          locationLat: lat,
          locationLng: lng,
        };
      }

      // Handle text messages
      if (msg.type === 'text') {
        const text = msg.text as Record<string, unknown> | undefined;
        return {
          messageId: wamid,
          phone,
          profileName,
          messageBody: (text?.body as string | undefined)?.trim() ?? '',
          isLocation: false,
        };
      }

      // Handle interactive messages (button replies, list replies)
      if (msg.type === 'interactive') {
        const interactive = msg.interactive as Record<string, unknown> | undefined;
        if (interactive?.type === 'button_reply') {
          const buttonReply = interactive.button_reply as Record<string, unknown>;
          return {
            messageId: wamid,
            phone,
            profileName,
            messageBody: (buttonReply?.title as string) ?? '',
            isLocation: false,
          };
        }
        if (interactive?.type === 'list_reply') {
          const listReply = interactive.list_reply as Record<string, unknown>;
          return {
            messageId: wamid,
            phone,
            profileName,
            messageBody: (listReply?.title as string) ?? '',
            isLocation: false,
          };
        }
      }

      // Ignore reactions, read receipts, and other non-content message types
      const msgType = msg.type as string | undefined;
      if (msgType === 'reaction' || msgType === 'system' || msgType === 'unsupported' || msgType === 'order' || msgType === 'ephemeral') {
        return null;
      }

      // Default: treat as empty (stickers, images, audio, video, etc.)
      return { messageId: wamid, phone, profileName, messageBody: '', isLocation: false };
    }
  }

  return null;
}

/* ─── Parse bid commands from user text ─── */

function parseAcceptCommand(message: string): number | null {
  const match = message.match(/(?:^|\bi\s+)accept\s+(\d+)$/i);
  if (match) return parseInt(match[1], 10);
  return null;
}

function parseCounterOffer(message: string): number | null {
  const lower = message.toLowerCase().trim();
  // Match plain numbers like "1500", "2000"
  const numMatch = lower.match(/^(\d{3,6})$/);
  if (numMatch) return parseInt(numMatch[1], 10);
  // Match "₦1500", "N1500"
  const currMatch = lower.match(/^[₦n]\s*(\d{3,6})$/);
  if (currMatch) return parseInt(currMatch[1], 10);
  // Match "1.5k", "2k"
  const kMatch = lower.match(/^(\d+(?:\.\d+)?)\s*k$/);
  if (kMatch) return Math.round(parseFloat(kMatch[1]) * 1000);
  // Match natural language with a number: "I rebid 1300", "counter offer to 1400", "my offer is ₦1200"
  const nlNum = lower.match(/(?:bid|offer|counter|price|pay)\b.*?[₦n]?\s*(\d{3,6})\b/);
  if (nlNum) return parseInt(nlNum[1], 10);
  // Match natural language with "k" shorthand: "I'll do 1.5k", "offer 2k"
  const nlK = lower.match(/(?:bid|offer|counter|price|pay)\b.*?(\d+(?:\.\d+)?)\s*k\b/);
  if (nlK) return Math.round(parseFloat(nlK[1]) * 1000);
  // Last resort: message with a number + negotiation keyword (e.g. "how about 1300", "I'll do 1.5k")
  const hasNegotiationWord = /\b(bid|offer|counter|price|pay|how\s*about|what\s*about|do|make\s*it|set|change)\b/.test(lower);
  if (hasNegotiationWord) {
    const anyK = lower.match(/\b(\d+(?:\.\d+)?)\s*k\b/);
    if (anyK) return Math.round(parseFloat(anyK[1]) * 1000);
    const anyNum = lower.match(/\b(\d{3,6})\b/);
    if (anyNum) return parseInt(anyNum[1], 10);
  }
  return null;
}

function isMoreCommand(message: string): boolean {
  return /^(more|more\s+drivers|refresh|next)$/i.test(message.trim());
}

function isCancelCommand(message: string): boolean {
  const m = message.trim().toLowerCase();
  if (/^cancel$/i.test(m)) return true;
  return /\b(cancel|stop|end|abort|nevermind|never\s*mind)\b.*\b(ride|trip|booking|withdrawal|withdraw)\b/i.test(m)
    || /\b(ride|trip|booking|withdrawal|withdraw)\b.*\b(cancel|stop|end|abort)\b/i.test(m);
}

function isEditPickupCommand(message: string): boolean {
  const m = message.trim().toLowerCase();
  return /\b(edit|change|update|modify)\b.*\b(pickup|pick\s*up|pick\s*-\s*up|origin|start|from)\b/i.test(m)
    || /\b(pickup|pick\s*up|pick\s*-\s*up|from)\b.*\b(edit|change|update|modify)\b/i.test(m)
    || /^edit\s*(pickup|from)$/i.test(m);
}

function isEditDestinationCommand(message: string): boolean {
  const m = message.trim().toLowerCase();
  return /\b(edit|change|update|modify)\b.*\b(destination|dest|drop\s*off|dropoff|drop\s*-\s*off|where|to)\b/i.test(m)
    || /\b(destination|dest|drop\s*off|dropoff|drop\s*-\s*off|to)\b.*\b(edit|change|update|modify)\b/i.test(m)
    || /^edit\s*(destination|to)$/i.test(m);
}

/** Extract inline address from edit command, e.g. "edit pickup golden gate bridge" → "golden gate bridge" */
function extractEditAddress(message: string): string | null {
  const m = message.trim();
  // Strip the command keywords, whatever remains is the address
  const stripped = m.replace(/\b(edit|change|update|modify)\b/i, '')
    .replace(/\b(pickup|pick\s*up|pick\s*-\s*up|origin|start|from|destination|dest|drop\s*off|dropoff|drop\s*-\s*off|where|to)\b/i, '')
    .replace(/\b(to|the)\b/gi, '')
    .trim();
  return stripped.length >= 3 ? stripped : null;
}

const CANCELLATION_REASON_PROMPT = [
  'Why do you want to cancel your ride?',
  '',
  '1. Long waiting time',
  '2. Wrong pickup or destination point',
  '3. Want to change ride type',
  '4. Accidental request',
  '',
  'Reply with *1–4* or type your reason.',
].join('\n');

const CANCELLATION_REASONS: Record<string, string> = {
  '1': 'Long waiting time',
  '2': 'Wrong pickup or destination point',
  '3': 'Want to change ride type',
  '4': 'Accidental request',
};

function parseCancellationReason(message: string): string | null {
  const normalized = message.trim().replace(/\s+/g, ' ');
  if (!normalized || isCancelCommand(normalized)) return null;

  const option = CANCELLATION_REASONS[normalized];
  if (option) return option;

  // Do not treat an unsupported numeric option as a free-text reason.
  if (/^\d+$/.test(normalized)) return null;

  return normalized.slice(0, 240);
}

function isWithdrawalCommand(message: string): boolean {
  const m = message.trim();
  if (isCancelCommand(m)) return false;
  if (isWithdrawalStatusCommand(m)) return false;
  return /^(withdraw|withdrawal|cash\s*out|cashout)$/i.test(m)
    || /\b(i\s+)?(want|wanna|need|like)\s+(to\s+)?(withdraw|cash\s*out)\b/i.test(m)
    || /^(withdraw|withdrawal|cash\s*out|cashout)\b/i.test(m)
    || /\b(send|move|transfer)\b.*\b(to\s+)?(my\s+)?(bank|account)\b/i.test(m);
}

function isWithdrawalStatusCommand(message: string): boolean {
  return /^(withdrawal?\s+status|withdrawals)$/i.test(message.trim());
}

function isWithdrawalStage(stage: string | null): boolean {
  return stage === 'awaiting_withdrawal_amount'
    || stage === 'awaiting_withdrawal_bank'
    || stage === 'awaiting_withdrawal_account'
    || stage === 'awaiting_withdrawal_confirmation';
}

function parseWithdrawalAmount(message: string): number | null {
  const normalized = message
    .trim()
    .replace(/^withdraw(?:al)?\s+/i, '')
    .replace(/[₦,\s]/g, '');
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null;

  const amount = Number(normalized);
  return Number.isFinite(amount) && amount > 0
    ? Math.round(amount * 100) / 100
    : null;
}

function normalizeBankSearch(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

async function findWithdrawalBank(
  pouch: PouchLiquifiaClient,
  query: string,
): Promise<{ bank: PouchBankAccount } | { matches: PouchBankAccount[] } | null> {
  const banks = await pouch.listBanks('NG', 'NGN');
  const normalizedQuery = normalizeBankSearch(query);
  const compactQuery = normalizedQuery.replace(/\s+/g, '');

  const exact = banks.filter((bank) => {
    const name = normalizeBankSearch(bank.name);
    const code = normalizeBankSearch(bank.code);
    return name === normalizedQuery
      || code === normalizedQuery
      || name.replace(/\s+/g, '') === compactQuery;
  });
  if (exact.length === 1) return { bank: exact[0] };

  const matches = banks.filter((bank) => {
    const name = normalizeBankSearch(bank.name);
    const code = normalizeBankSearch(bank.code);
    return name.includes(normalizedQuery)
      || code.includes(normalizedQuery)
      || normalizedQuery.includes(name);
  });

  if (matches.length === 1) return { bank: matches[0] };
  return matches.length > 0 ? { matches: matches.slice(0, 6) } : null;
}

async function sendWhatsappText(
  deps: MetaWhatsappRouteDeps,
  phone: string,
  incomingMessage: string,
  reply: string,
): Promise<void> {
  await appendWhatsappConversation(deps.redisClient, phone, [
    { role: 'user', content: incomingMessage },
    { role: 'assistant', content: reply },
  ]);
  await sendMetaReply(deps, phone, reply);
}

async function submitWhatsappWithdrawal(params: {
  deps: MetaWhatsappRouteDeps;
  userId: string;
  amountNgn: number;
  bankUuid: string;
  accountNumber: string;
  accountName: string;
}): Promise<{ id: string; status: string }> {
  const { deps, userId, amountNgn, bankUuid, accountNumber, accountName } = params;
  const lockKey = `whatsapp:user:${userId}:withdrawal_submit_lock`;
  const lockToken = randomUUID();
  const acquired = await deps.redisClient.setIfNotExists(lockKey, lockToken, 120);
  if (!acquired) {
    throw new Error('A withdrawal is already being processed. Please wait a moment.');
  }

  let reservedRequestId: string | undefined;
  try {
    const wallet = await walletClient.findByUserId(userId);
    if (!wallet) throw new Error('No wallet found. Fund your account first.');

    const virtualAccount = await virtualAccountClient.findByUserId(userId);
    if (!virtualAccount) {
      throw new Error('No deposit account found. Please complete wallet setup first.');
    }

    const reserveResult = await withdrawalClient.reserve({
      userId,
      walletId: wallet.id,
      amountNgn,
      bankAccountNumber: accountNumber,
      bankAccountName: accountName,
      bankNetworkId: bankUuid,
    });
    reservedRequestId = reserveResult.request.id;

    const payout = await deps.pouchLiquifiaClient.createPayout({
      virtualAccountId: virtualAccount.pouchVirtualAccountId,
      reference: reserveResult.request.id,
      amount: amountNgn,
      destinationAccount: accountNumber,
      destinationBankUuid: bankUuid,
      idempotencyKey: reserveResult.request.id,
    });

    await withdrawalClient.attachPayout({
      withdrawalRequestId: reserveResult.request.id,
      pouchPayoutId: payout.id,
      providerReference: payout.reference,
    });

    const payoutCreatedEvent: PayoutCreatedEvent = {
      eventType: 'PAYOUT_CREATED',
      userId,
      pouchPayoutId: payout.id,
      withdrawalId: reserveResult.request.id,
      amountNgn,
      bankAccountNumber: accountNumber,
      bankAccountName: accountName,
      bankNetworkId: bankUuid,
      timestamp: new Date().toISOString(),
    };
    await deps.publisher.publishPaymentEvent(payoutCreatedEvent);

    return {
      id: reserveResult.request.id,
      status: 'PAYOUT_CREATED',
    };
  } catch (error) {
    if (reservedRequestId) {
      await withdrawalClient.releaseFailedRequest({
        withdrawalRequestId: reservedRequestId,
        failureReason: error instanceof Error ? error.message : 'Withdrawal creation failed.',
        status: 'FAILED',
      }).catch(() => undefined);
    }
    throw error;
  } finally {
    await deps.redisClient.del(lockKey).catch(() => {});
  }
}

/* ─── Main POST webhook handler ─── */

export async function handleMetaWhatsappWebhookRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: MetaWhatsappRouteDeps,
): Promise<void> {
  try {
    const rawBody = await readRawBody(req);

    if (!isValidMetaSignature(rawBody, getHeaderValue(req, 'x-hub-signature-256'), deps.metaAppSecret)) {
      sendJson(res, 403, { error: 'Invalid signature' });
      return;
    }

    // Always respond 200 quickly — Meta requires fast acknowledgement
    sendOk(res);

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody.toString('utf8'));
    } catch {
      console.warn('[whatsapp] Invalid JSON in Meta webhook');
      return;
    }

    // Meta sends status updates (delivered, read) — ignore them
    const msgInfo = extractMetaMessage(parsed);
    if (!msgInfo) return;

    // ── Dedup: Meta retries webhooks — skip if we already processed this message ──
    if (msgInfo.messageId) {
      const dedupKey = `whatsapp:dedup:${msgInfo.messageId}`;
      const alreadyProcessed = await deps.redisClient.get(dedupKey).catch(() => null);
      if (alreadyProcessed) return;
      await deps.redisClient.set(dedupKey, '1', 300).catch(() => {});
    }

    const { phone, profileName, messageBody: incomingMessage, isLocation, locationLat, locationLng } = msgInfo;

    const user = await onboardWhatsappUser({
      phone,
      profileName,
      deps: {
        jwtSecret: deps.jwtSecret,
        publisher: deps.publisher,
        pouchLiquifiaClient: deps.pouchLiquifiaClient,
      },
    });

    // Store phone lookup for Kafka consumer notifications
    await setPhoneLookup(deps.redisClient, user.id, phone).catch(() => {});

    const activeRideId = await getActiveRide(deps.redisClient, user.id);
    const bookingStage = await getBookingStage(deps.redisClient, user.id);

    // ── Cancellation reason — collect this before clearing the booking ──
    if (bookingStage === 'awaiting_cancel_reason') {
      const reason = parseCancellationReason(incomingMessage);

      if (!reason) {
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage || '[Shared location pin]' },
          { role: 'assistant', content: CANCELLATION_REASON_PROMPT },
        ]);
        await sendMetaReply(deps, phone, CANCELLATION_REASON_PROMPT);
        return;
      }

      if (activeRideId) {
        const cancelEvent = RideCancelledEvent.parse({
          eventType: 'RIDE_CANCELLED',
          rideId: activeRideId,
          riderId: user.id,
          reason,
          timestamp: new Date().toISOString(),
        });
        await deps.publisher.publishRideEvent(cancelEvent);
        await clearActiveRide(deps.redisClient, user.id);
        await cleanupRideKeys(deps.redisClient, activeRideId);
        await clearPendingAccept(deps.redisClient, user.id);
      }

      await clearBookingStage(deps.redisClient, user.id);
      await clearPendingRoute(deps.redisClient, user.id);
      await clearPendingLocation(deps.redisClient, user.id);

      const reply = [
        activeRideId ? 'Ride cancelled.' : 'Booking cancelled.',
        `Reason: ${reason}`,
        '',
        'Any fare held for this ride will be returned to your wallet.',
      ].join('\n');
      await appendWhatsappConversation(deps.redisClient, phone, [
        { role: 'user', content: incomingMessage },
        { role: 'assistant', content: reply },
      ]);
      await sendMetaReply(deps, phone, reply);
      return;
    }

    // ── Wallet withdrawal flow ────────────────────────────────────────────
    if (isWithdrawalCommand(incomingMessage) && !isLocation && !activeRideId) {
      await clearPendingWhatsappWithdrawal(deps.redisClient, user.id);
      await setBookingStage(deps.redisClient, user.id, 'awaiting_withdrawal_amount');

      const wallet = await walletClient.findByUserId(user.id).catch(() => null);
      const balance = wallet ? Number(wallet.balanceNgn) : 0;
      const MIN_WITHDRAWAL_NGN = 5000;

      if (!wallet || !Number.isFinite(balance) || balance < MIN_WITHDRAWAL_NGN) {
        const va = await virtualAccountClient.findByUserId(user.id).catch(() => null);
        const shortage = MIN_WITHDRAWAL_NGN - Math.max(0, balance);
        const lines = [
          balance > 0
            ? `Your wallet balance is ₦${balance.toLocaleString()}, but the minimum withdrawal is ₦${MIN_WITHDRAWAL_NGN.toLocaleString()}.`
            : 'Your wallet has no available balance to withdraw.',
          '',
          `Top up at least ₦${shortage.toLocaleString()} to withdraw.`,
        ];
        if (va) {
          lines.push('', `Deposit to *${va.bankName}*`, `\`\`\`${va.accountNumber}\`\`\``);
        }
        await clearBookingStage(deps.redisClient, user.id);
        await sendWhatsappText(deps, phone, incomingMessage, lines.join('\n'));
        return;
      }

      const reply = `Your available wallet balance is ₦${balance.toLocaleString()}\n\nHow much do you want to withdraw? (Minimum ₦${MIN_WITHDRAWAL_NGN.toLocaleString()})\nSend an amount, e.g. *5000*.`;
      await sendWhatsappText(deps, phone, incomingMessage, reply);
      return;
    }

    if (isWithdrawalStatusCommand(incomingMessage) && !isLocation) {
      const latest = (await withdrawalClient.listByUser(user.id, 1).catch(() => []))[0];
      if (!latest) {
        await sendWhatsappText(deps, phone, incomingMessage, 'You have no withdrawal requests yet. Reply *withdraw* to start one.');
        return;
      }

      const accountLast4 = latest.bankAccountNumber.slice(-4);
      const failure = latest.failureReason ? `\nReason: ${latest.failureReason}` : '';
      const reply = [
        `Withdrawal: ₦${Number(latest.requestedAmountNgn).toLocaleString()}`,
        `Status: *${latest.status}*`,
        `Bank account: ••••${accountLast4}`,
        `Requested: ${latest.createdAt.toLocaleString()}`,
        failure,
      ].filter(Boolean).join('\n');
      await sendWhatsappText(deps, phone, incomingMessage, `${reply}\n\nReply *withdraw status* to check again.`);
      return;
    }

    if (isWithdrawalStage(bookingStage) && !activeRideId) {
      const pending = await getPendingWhatsappWithdrawal(deps.redisClient, user.id);

      if (isCancelCommand(incomingMessage)) {
        await clearPendingWhatsappWithdrawal(deps.redisClient, user.id);
        await clearBookingStage(deps.redisClient, user.id);
        await sendWhatsappText(deps, phone, incomingMessage, 'Withdrawal cancelled. Your wallet balance was not changed.');
        return;
      }

      if (!pending && bookingStage !== 'awaiting_withdrawal_amount') {
        await clearBookingStage(deps.redisClient, user.id);
        await sendWhatsappText(deps, phone, incomingMessage, 'This withdrawal session expired. Reply *withdraw* to start again.');
        return;
      }

      // After the guard above, pending is guaranteed non-null for all stages
      // except awaiting_withdrawal_amount (which doesn't use it).
      const withdrawal = pending!;

      if (bookingStage === 'awaiting_withdrawal_amount') {
        const amountNgn = parseWithdrawalAmount(incomingMessage);
        if (amountNgn === null) {
          await sendWhatsappText(deps, phone, incomingMessage, 'Please send a valid withdrawal amount, e.g. *5000*.');
          return;
        }

        const MIN_WITHDRAWAL_NGN = 5000;
        if (amountNgn < MIN_WITHDRAWAL_NGN) {
          await sendWhatsappText(deps, phone, incomingMessage, `The minimum withdrawal amount is ₦${MIN_WITHDRAWAL_NGN.toLocaleString()}. Please send a higher amount.`);
          return;
        }

        const wallet = await walletClient.findByUserId(user.id).catch(() => null);
        const balance = wallet ? Number(wallet.balanceNgn) : 0;
        if (!wallet || !Number.isFinite(balance) || balance < amountNgn) {
          await sendWhatsappText(
            deps,
            phone,
            incomingMessage,
            `You can withdraw up to ₦${Math.max(0, balance).toLocaleString()}. Please send a higher balance or top up first.`,
          );
          return;
        }

        await storePendingWhatsappWithdrawal(deps.redisClient, user.id, { amountNgn });
        await setBookingStage(deps.redisClient, user.id, 'awaiting_withdrawal_bank');
        await sendWhatsappText(deps, phone, incomingMessage, 'Which bank should receive the money?\n\nType the bank name, e.g. *GTBank*, *Opay*, or *UBA*.');
        return;
      }

      if (bookingStage === 'awaiting_withdrawal_bank') {
        // If the user sends a number (possibly prefixed with filler words), they're correcting the amount
        const correctedAmount = parseWithdrawalAmount(
          incomingMessage.trim().replace(/^(no|nah|wait|actually|i\s+meant?|not|sorry|change\s+to)\s+/i, ''),
        );
        if (correctedAmount !== null) {
          const MIN_WITHDRAWAL_NGN = 5000;
          if (correctedAmount < MIN_WITHDRAWAL_NGN) {
            await sendWhatsappText(deps, phone, incomingMessage, `The minimum withdrawal amount is ₦${MIN_WITHDRAWAL_NGN.toLocaleString()}. Please send a higher amount.`);
            return;
          }
          const wallet = await walletClient.findByUserId(user.id).catch(() => null);
          const balance = wallet ? Number(wallet.balanceNgn) : 0;
          if (!wallet || !Number.isFinite(balance) || balance < correctedAmount) {
            await sendWhatsappText(
              deps, phone, incomingMessage,
              `You can withdraw up to ₦${Math.max(0, balance).toLocaleString()}. Please send a higher balance or top up first.`,
            );
            return;
          }
          await storePendingWhatsappWithdrawal(deps.redisClient, user.id, { amountNgn: correctedAmount });
          await sendWhatsappText(deps, phone, incomingMessage, `Amount updated to *₦${correctedAmount.toLocaleString()}*.\n\nWhich bank should receive the money?\nType the bank name, e.g. *GTBank*, *Opay*, or *UBA*.`);
          return;
        }

        const bankQuery = incomingMessage.trim();
        if (!bankQuery) {
          await sendWhatsappText(deps, phone, incomingMessage, 'Please type the name of the bank that should receive the money.');
          return;
        }

        try {
          const result = await findWithdrawalBank(deps.pouchLiquifiaClient, bankQuery);
          if (!result) {
            await sendWhatsappText(deps, phone, incomingMessage, 'I could not find that bank. Please type the bank name again.');
            return;
          }

          if ('matches' in result) {
            const choices = result.matches.map((bank, index) => `${index + 1}. ${bank.name}`).join('\n');
            await sendWhatsappText(deps, phone, incomingMessage, `I found more than one bank:\n${choices}\n\nPlease type the exact bank name.`);
            return;
          }

          await storePendingWhatsappWithdrawal(deps.redisClient, user.id, {
            ...withdrawal,
            bankUuid: result.bank.uuid,
            bankName: result.bank.name,
          });
          await setBookingStage(deps.redisClient, user.id, 'awaiting_withdrawal_account');
          await sendWhatsappText(deps, phone, incomingMessage, `Bank selected: *${result.bank.name}*\n\nSend the 10-digit account number.`);
        } catch {
          await sendWhatsappText(deps, phone, incomingMessage, 'I could not load the bank list right now. Please try again in a moment.');
        }
        return;
      }

      if (bookingStage === 'awaiting_withdrawal_account') {
        const accountNumber = incomingMessage.replace(/\D/g, '');
        if (!/^\d{10}$/.test(accountNumber) || !withdrawal.bankUuid) {
          await sendWhatsappText(deps, phone, incomingMessage, 'Please send a valid 10-digit bank account number.');
          return;
        }

        try {
          const verified = await deps.pouchLiquifiaClient.validateBankAccount({
            accountNumber,
            bankUuid: withdrawal.bankUuid,
          });
          const verifiedAccountNumber = verified.account_number || accountNumber;
          const accountName = verified.account_name?.trim();
          if (!accountName) {
            await sendWhatsappText(deps, phone, incomingMessage, 'I could not verify that account. Check the number and try again.');
            return;
          }

          const bankName = verified.bank_name || withdrawal.bankName || 'Selected bank';
          await storePendingWhatsappWithdrawal(deps.redisClient, user.id, {
            ...withdrawal,
            bankName,
            accountNumber: verifiedAccountNumber,
            accountName,
          });
          await setBookingStage(deps.redisClient, user.id, 'awaiting_withdrawal_confirmation');

          const reply = [
            'Please confirm this withdrawal:',
            '',
            `Amount: *₦${withdrawal.amountNgn.toLocaleString()}*`,
            `Bank: *${bankName}*`,
            `Account: *${verifiedAccountNumber}*`,
            `Name: *${accountName}*`,
            '',
            'Reply *yes* to submit or *cancel* to stop.',
          ].join('\n');
          await sendWhatsappText(deps, phone, incomingMessage, reply);
        } catch {
          await sendWhatsappText(deps, phone, incomingMessage, 'I could not verify that account. Check the bank and account number, then try again.');
        }
        return;
      }

      if (bookingStage === 'awaiting_withdrawal_confirmation') {
        if (!/^(yes|confirm|proceed|submit)$/i.test(incomingMessage.trim())) {
          await sendWhatsappText(deps, phone, incomingMessage, 'Reply *yes* to submit the withdrawal or *cancel* to stop.');
          return;
        }

        if (!withdrawal.bankUuid || !withdrawal.accountNumber || !withdrawal.accountName) {
          await clearPendingWhatsappWithdrawal(deps.redisClient, user.id);
          await clearBookingStage(deps.redisClient, user.id);
          await sendWhatsappText(deps, phone, incomingMessage, 'This withdrawal session is incomplete. Reply *withdraw* to start again.');
          return;
        }

        try {
          const submitted = await submitWhatsappWithdrawal({
            deps,
            userId: user.id,
            amountNgn: withdrawal.amountNgn,
            bankUuid: withdrawal.bankUuid,
            accountNumber: withdrawal.accountNumber,
            accountName: withdrawal.accountName,
          });
          await clearPendingWhatsappWithdrawal(deps.redisClient, user.id);
          await clearBookingStage(deps.redisClient, user.id);

          const reply = [
            '✅ Withdrawal submitted successfully.',
            '',
            `Amount: *₦${withdrawal.amountNgn.toLocaleString()}*`,
            `Account: *${withdrawal.accountNumber}*`,
            `Status: *${submitted.status}*`,
            '',
            'Your funds are being sent to your bank account. Reply *withdraw status* to check progress.',
          ].join('\n');
          await sendWhatsappText(deps, phone, incomingMessage, reply);
        } catch (error) {
          console.error('[whatsapp] withdrawal submit error', {
            userId: user.id,
            error: error instanceof Error ? error.message : String(error),
          });
          await sendWhatsappText(deps, phone, incomingMessage, 'Withdrawal failed. Please try again later.\n\nYour wallet balance was not deducted. Reply *withdraw* to retry.');
        }
        return;
      }
    }

    // ══════════════════════════════════════════════════════════════════════
    // 1. ACTIVE RIDE — handle accept/counter/more/cancel commands
    // ══════════════════════════════════════════════════════════════════════

    if (activeRideId && !isLocation) {
      // ── Ride already confirmed/in progress — only allow cancel ──
      const rideState = await getRideState(deps.redisClient, activeRideId).catch(() => null);
      const confirmedStates = ['confirmed', 'in_progress', 'driver_assigned'];
      if (rideState && confirmedStates.includes(rideState)) {
        if (isCancelCommand(incomingMessage)) {
          await setBookingStage(deps.redisClient, user.id, 'awaiting_cancel_reason');
          await sendMetaReply(deps, phone, CANCELLATION_REASON_PROMPT);
          return;
        }
        const acceptedBid = await deps.redisClient.get(`whatsapp:ride:${activeRideId}:accepted`).catch(() => null);
        const accepted = acceptedBid ? JSON.parse(acceptedBid) : null;
        const driverName = accepted?.driverName ?? 'your driver';
        const reply = `Your ride with *${driverName}* is in progress. Sit tight! 🚗\n\nReply *cancel* if you need to cancel.`;
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }

      // ── Edit pickup / destination during active ride ──
      if (isEditPickupCommand(incomingMessage) || isEditDestinationCommand(incomingMessage)) {
        const isPickup = isEditPickupCommand(incomingMessage);
        const rideMeta = await getRideMeta(deps.redisClient, activeRideId);

        if (rideMeta && rideMeta.pickupLat && rideMeta.pickupLng && rideMeta.destinationLat && rideMeta.destinationLng) {
          const inlineAddress = extractEditAddress(incomingMessage);

          if (inlineAddress) {
            // Geocode FIRST — don't cancel the ride until we know the address is valid
            const geo = await geocodeAddress(deps.googleMapsApiKey, inlineAddress);
            if (!geo) {
              const label = isPickup ? 'pickup' : 'destination';
              const reply = `Could not find "${inlineAddress}" on the map. Your ride is still active.\n\nTry a more specific ${label} address or share a location pin 📍`;
              await appendWhatsappConversation(deps.redisClient, phone, [
                { role: 'user', content: incomingMessage },
                { role: 'assistant', content: reply },
              ]);
              await sendMetaReply(deps, phone, reply);
              return;
            }

            // Geocode succeeded — now cancel the old ride
            const cancelEvent = RideCancelledEvent.parse({
              eventType: 'RIDE_CANCELLED',
              rideId: activeRideId,
              riderId: user.id,
              reason: 'rider_editing_route',
              timestamp: new Date().toISOString(),
            });
            await deps.publisher.publishRideEvent(cancelEvent);
            await clearActiveRide(deps.redisClient, user.id);
            await cleanupRideKeys(deps.redisClient, activeRideId);
            await clearPendingAccept(deps.redisClient, user.id);

            const pickup = isPickup
              ? { lat: geo.lat, lng: geo.lng, address: geo.formattedAddress }
              : { lat: rideMeta.pickupLat, lng: rideMeta.pickupLng, address: rideMeta.pickupAddress };
            const destination = !isPickup
              ? { lat: geo.lat, lng: geo.lng, address: geo.formattedAddress }
              : { lat: rideMeta.destinationLat, lng: rideMeta.destinationLng, address: rideMeta.destinationAddress };

            const plannedRoute = await deps.routePlanner.planRoute({ origin: pickup, destination });
            const distanceKm = plannedRoute.distanceKm;
            const durationMin = Math.ceil(plannedRoute.durationSeconds / 60);
            const suggestedFare = plannedRoute.suggestedFareNgn;
            const minFare = plannedRoute.minOfferNgn;

            await storePendingRoute(deps.redisClient, user.id, {
              pickupLat: pickup.lat, pickupLng: pickup.lng, pickupAddress: pickup.address,
              destLat: destination.lat, destLng: destination.lng, destAddress: destination.address,
              distanceKm, durationSeconds: plannedRoute.durationSeconds,
              suggestedFareNgn: suggestedFare, minOfferNgn: minFare,
              ratePerKmNgn: plannedRoute.ratePerKmNgn, route: plannedRoute.geometry,
            });
            await setBookingStage(deps.redisClient, user.id, 'awaiting_price');

            const editedLabel = isPickup ? 'Pickup updated!' : 'Destination updated!';
            const reply = [
              `✅ *${editedLabel}*`,
              ``,
              `Pickup: *${pickup.address}*`,
              ``,
              `Destination: *${destination.address}*`,
              ``,
              `${distanceKm.toFixed(1)} km · ~${durationMin} min`,
              `Minimum fare: ₦${minFare.toLocaleString()}`,
              `Suggested fare: ₦${suggestedFare.toLocaleString()}`,
              ``,
              `Send your offer (e.g. *${suggestedFare.toLocaleString()}* or *${Math.round(suggestedFare * 0.85).toLocaleString()}*)`,
            ].join('\n');

            await appendWhatsappConversation(deps.redisClient, phone, [
              { role: 'user', content: incomingMessage },
              { role: 'assistant', content: reply },
            ]);
            await sendMetaReply(deps, phone, reply);
            return;
          }

          // No inline address — don't cancel yet, just switch to editing stage
          // Store route from current ride meta so editing handlers can replan
          await storePendingRoute(deps.redisClient, user.id, {
            pickupLat: rideMeta.pickupLat, pickupLng: rideMeta.pickupLng, pickupAddress: rideMeta.pickupAddress,
            destLat: rideMeta.destinationLat, destLng: rideMeta.destinationLng, destAddress: rideMeta.destinationAddress,
            distanceKm: rideMeta.distanceKm ?? 0, durationSeconds: rideMeta.durationSeconds ?? 0,
            suggestedFareNgn: rideMeta.suggestedFareNgn, minOfferNgn: 0, ratePerKmNgn: 0, route: null,
          });

          const label = isPickup ? 'pickup' : 'destination';
          const current = isPickup ? rideMeta.pickupAddress : rideMeta.destinationAddress;
          await setBookingStage(deps.redisClient, user.id, isPickup ? 'editing_pickup' : 'editing_destination');

          const reply = `Current ${label}: *${current}*\n\nSend a new ${label} location pin 📍 or type the address.`;
          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: incomingMessage },
            { role: 'assistant', content: reply },
          ]);
          await sendMetaReply(deps, phone, reply);
          return;
        }
      }

      // ── Cancel command ──
      if (isCancelCommand(incomingMessage)) {
        await setBookingStage(deps.redisClient, user.id, 'awaiting_cancel_reason');
        const reply = CANCELLATION_REASON_PROMPT;
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }

      // ── Pay — rider pays to confirm the selected driver ──
      const pendingAccept = await getPendingAccept(deps.redisClient, user.id);
      if (pendingAccept && /^(yes|confirm|accept|go|proceed|pay)$/i.test(incomingMessage.trim())) {
        // Verify ride still exists before taking payment
        const rideMeta = await getRideMeta(deps.redisClient, pendingAccept.rideId);
        if (!rideMeta) {
          await clearPendingAccept(deps.redisClient, user.id);
          await clearActiveRide(deps.redisClient, user.id);
          const reply = 'This ride has expired. Please start a new booking.';
          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: incomingMessage },
            { role: 'assistant', content: reply },
          ]);
          await sendMetaReply(deps, phone, reply);
          return;
        }

        const agreedFare = pendingAccept.fareNgn;

        // Check wallet balance
        const wallet = await walletClient.findByUserId(user.id);
        const balance = wallet ? Number(wallet.balanceNgn) : 0;

        if (!wallet || balance < agreedFare) {
          const shortage = agreedFare - balance;
          const va = await virtualAccountClient.findByUserId(user.id);

          const lines = [
            `Your wallet balance is ₦${balance.toLocaleString()} but the ride costs ₦${agreedFare.toLocaleString()}.`,
            ``,
            `You need ₦${shortage.toLocaleString()} more.`,
          ];

          if (va) {
            lines.push(
              ``,
              `Top up your wallet:`,
              `Bank: *${va.bankName}*`,
              `Account: \`\`\`${va.accountNumber}\`\`\``,
              `Name: *${va.accountName}*`,
              ``,
              `Once funded, reply *pay* to confirm.`,
            );
          } else {
            lines.push(``, `Please top up your wallet and reply *pay*.`);
          }

          const reply = lines.join('\n');
          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: incomingMessage },
            { role: 'assistant', content: reply },
          ]);
          await sendMetaReply(deps, phone, reply);
          return;
        }

        // Lock funds
        try {
          await walletClient.createRideHold({
            rideId: pendingAccept.rideId,
            walletId: wallet.id,
            riderId: user.id,
            driverUserId: pendingAccept.driverUserId,
            amountNgn: agreedFare,
          });
        } catch {
          const reply = 'Could not lock funds in your wallet. Please try again — reply *pay*.';
          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: incomingMessage },
            { role: 'assistant', content: reply },
          ]);
          await sendMetaReply(deps, phone, reply);
          return;
        }

        // Payment successful — confirm the ride
        await clearPendingAccept(deps.redisClient, user.id);

        const acceptEvent = RideOfferAcceptedEvent.parse({
          eventType: 'RIDE_OFFER_ACCEPTED',
          rideId: pendingAccept.rideId,
          riderId: user.id,
          driverId: pendingAccept.driverId,
          driverUserId: pendingAccept.driverUserId,
          agreedFareNgn: agreedFare,
          paymentMethod: 'WALLET',
          timestamp: new Date().toISOString(),
        });
        await deps.publisher.publishRideEvent(acceptEvent);
        await setRideState(deps.redisClient, pendingAccept.rideId, 'confirmed');

        await storeAcceptedBid(deps.redisClient, pendingAccept.rideId, {
          driverName: pendingAccept.driverName,
          driverPhone: pendingAccept.driverPhone,
          driverUserId: pendingAccept.driverUserId,
          vehicleModel: pendingAccept.vehicleModel,
          vehiclePlate: pendingAccept.vehiclePlate,
          vehicleColor: '',
          driverRating: pendingAccept.driverRating,
          totalRides: pendingAccept.totalRides,
          etaSeconds: pendingAccept.etaSeconds,
          fareNgn: agreedFare,
        });

        // Send driver selfie + vehicle photo now that they've paid
        if (deps.driverKycStorage) {
          try {
            const kyc = await driverClient.findKycSubmission(pendingAccept.driverId);
            if (kyc) {
              const imagePromises: Promise<void>[] = [];
              if (kyc.selfieKey) {
                const selfieUrl = await deps.driverKycStorage.getSignedUrl(kyc.selfieKey);
                imagePromises.push(sendMetaImageMessage(deps, phone, selfieUrl, `${pendingAccept.driverName}`));
              }
              if (kyc.vehicleImageKeys?.length) {
                const vehicleUrl = await deps.driverKycStorage.getSignedUrl(kyc.vehicleImageKeys[0]);
                imagePromises.push(sendMetaImageMessage(deps, phone, vehicleUrl, `${pendingAccept.vehicleModel} (${pendingAccept.vehiclePlate})`));
              }
              await Promise.all(imagePromises);
            }
          } catch {
            // Non-critical — confirmation message still goes out
          }
        }

        const etaMin = Math.ceil(pendingAccept.etaSeconds / 60);
        const reply = [
          `✅ *Ride confirmed & paid!*`,
          ``,
          `💰 ₦${agreedFare.toLocaleString()} deducted from your wallet`,
          ``,
          `Driver: *${pendingAccept.driverName}*`,
          `Vehicle: ${pendingAccept.vehicleModel} (${pendingAccept.vehiclePlate})`,
          `Rating: ${pendingAccept.driverRating.toFixed(1)}★ · ${pendingAccept.totalRides} rides`,
          `ETA: ${etaMin} min`,
          ``,
          `Your driver is on the way! 🚗`,
        ].join('\n');

        // Clear pending accept so rider can't accidentally pay twice
        await clearPendingAccept(deps.redisClient, user.id);

        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }

      // ── Accept a driver: "accept 1", "accept 3" (can override pending accept) ──
      const acceptNum = parseAcceptCommand(incomingMessage);
      if (acceptNum !== null) {
        const lastBatch = await getLastBatch(deps.redisClient, activeRideId);

        if (lastBatch.length === 0) {
          const reply = 'No drivers have bid yet. Hold tight — we\'ll notify you when drivers respond!';
          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: incomingMessage },
            { role: 'assistant', content: reply },
          ]);
          await sendMetaReply(deps, phone, reply);
          return;
        }

        const bidIndex = acceptNum - 1;
        const selectedBid = lastBatch[bidIndex];

        if (!selectedBid) {
          const reply = `Invalid driver number. Reply with a number from 1 to ${lastBatch.length}.`;
          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: incomingMessage },
            { role: 'assistant', content: reply },
          ]);
          await sendMetaReply(deps, phone, reply);
          return;
        }

        // Fetch driver details for storage
        let driverPhone = '';
        let totalRides = 0;
        try {
          const driver = await driverClient.findById(selectedBid.driverId);
          driverPhone = driver.user.phone ?? '';
          totalRides = driver.totalRides ?? 0;
        } catch {
          // Non-critical
        }

        // Store pending accept — rider must pay before seeing full details
        await storePendingAccept(deps.redisClient, user.id, {
          rideId: activeRideId,
          driverId: selectedBid.driverId,
          driverUserId: selectedBid.driverUserId,
          driverName: selectedBid.driverName,
          driverPhone,
          driverRating: selectedBid.driverRating,
          totalRides,
          vehicleModel: selectedBid.vehicleModel,
          vehiclePlate: selectedBid.vehiclePlate,
          etaSeconds: selectedBid.etaSeconds,
          fareNgn: selectedBid.counterOfferNgn,
        });

        const fareNgn = selectedBid.counterOfferNgn;
        const reply = `You selected *${selectedBid.driverName}* — ₦${fareNgn.toLocaleString()}\n\nReply *pay* to confirm and pay from your wallet.`;

        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }

      // ── "more" command — show latest bids ──
      if (isMoreCommand(incomingMessage)) {
        const allBids = await getBids(deps.redisClient, activeRideId);
        const meta = await getRideMeta(deps.redisClient, activeRideId);

        if (allBids.length === 0) {
          const reply = 'Still looking for drivers... I\'ll message you when they respond! 🔍';
          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: incomingMessage },
            { role: 'assistant', content: reply },
          ]);
          await sendMetaReply(deps, phone, reply);
          return;
        }

        await storeLastBatch(deps.redisClient, activeRideId, allBids);
        const reply = formatBidList(allBids, meta?.offerNgn ?? 0);
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }

      // ── Counter-offer with a price: "1500", "₦2000", "2k" ──
      const counterOffer = parseCounterOffer(incomingMessage);
      if (counterOffer !== null) {
        const meta = await getRideMeta(deps.redisClient, activeRideId);
        if (meta) {
          // Update the rider's offer in Redis
          meta.offerNgn = counterOffer;
          await deps.redisClient.set(
            `whatsapp:ride:${activeRideId}:meta`,
            JSON.stringify(meta),
            900,
          );

          // Publish counter-offer to ride-service so all drivers see the updated price
          await deps.publisher.publishRideEvent({
            eventType: 'RIDE_RIDER_COUNTER_OFFER',
            rideId: activeRideId,
            riderId: meta.riderId,
            counterOfferNgn: counterOffer,
            timestamp: new Date().toISOString(),
          });

          const reply = `Bid updated to ₦${counterOffer.toLocaleString()}. Drivers will see your new offer.`;
          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: incomingMessage },
            { role: 'assistant', content: reply },
          ]);
          await sendMetaReply(deps, phone, reply);
          return;
        }
      }

      // ── Pending accept but unrecognized command — remind to pay ──
      if (pendingAccept) {
        const reply2 = `Reply *pay* to confirm ${pendingAccept.driverName} at ₦${pendingAccept.fareNgn.toLocaleString()}, or *accept #* to pick a different driver, or *cancel* to cancel.`;
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply2 },
        ]);
        await sendMetaReply(deps, phone, reply2);
        return;
      }

      // ── Active ride but unrecognized command — remind them ──
      const reply = 'You have an active ride. Reply:\n• *accept 1* — to accept a driver\n• A *price* (e.g. "2000") — to counter-offer\n• *more* — to see drivers\n• *edit from* / *edit to* — to change pickup or destination\n• *cancel* — to cancel';
      await appendWhatsappConversation(deps.redisClient, phone, [
        { role: 'user', content: incomingMessage },
        { role: 'assistant', content: reply },
      ]);
      await sendMetaReply(deps, phone, reply);
      return;
    }

    // ══════════════════════════════════════════════════════════════════════
    // 2. LOCATION PIN — handle pickup and destination location shares
    // ══════════════════════════════════════════════════════════════════════

    if (isLocation && locationLat !== undefined && locationLng !== undefined && !isNaN(locationLat) && !isNaN(locationLng)) {
      // Block location pins during active ride (unless editing)
      if (activeRideId && bookingStage !== 'editing_pickup' && bookingStage !== 'editing_destination') {
        const reply = 'You have an active ride. Reply *edit from* or *edit to* to change your route, or *cancel* to start fresh.';
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: '[Shared location pin]' },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }

      const reverseGeo = await reverseGeocode(deps.googleMapsApiKey, locationLat, locationLng);
      const address = reverseGeo?.formattedAddress ?? `${locationLat.toFixed(4)}, ${locationLng.toFixed(4)}`;

      // ── Editing pickup/destination via location pin ──
      if (bookingStage === 'editing_pickup' || bookingStage === 'editing_destination') {
        const pendingRoute = await getPendingRoute(deps.redisClient, user.id);
        if (pendingRoute) {
          const pickup = bookingStage === 'editing_pickup'
            ? { lat: locationLat, lng: locationLng, address }
            : { lat: pendingRoute.pickupLat, lng: pendingRoute.pickupLng, address: pendingRoute.pickupAddress };
          const destination = bookingStage === 'editing_destination'
            ? { lat: locationLat, lng: locationLng, address }
            : { lat: pendingRoute.destLat, lng: pendingRoute.destLng, address: pendingRoute.destAddress };

          const plannedRoute = await deps.routePlanner.planRoute({ origin: pickup, destination });
          const distanceKm = plannedRoute.distanceKm;
          const durationMin = Math.ceil(plannedRoute.durationSeconds / 60);
          const suggestedFare = plannedRoute.suggestedFareNgn;
          const minFare = plannedRoute.minOfferNgn;

          // If rider had an active ride, cancel it now that the edit succeeded
          if (activeRideId) {
            const cancelEvent = RideCancelledEvent.parse({
              eventType: 'RIDE_CANCELLED',
              rideId: activeRideId,
              riderId: user.id,
              reason: 'rider_editing_route',
              timestamp: new Date().toISOString(),
            });
            await deps.publisher.publishRideEvent(cancelEvent);
            await clearActiveRide(deps.redisClient, user.id);
            await cleanupRideKeys(deps.redisClient, activeRideId);
            await clearPendingAccept(deps.redisClient, user.id);
          }

          await storePendingRoute(deps.redisClient, user.id, {
            pickupLat: pickup.lat,
            pickupLng: pickup.lng,
            pickupAddress: pickup.address,
            destLat: destination.lat,
            destLng: destination.lng,
            destAddress: destination.address,
            distanceKm,
            durationSeconds: plannedRoute.durationSeconds,
            suggestedFareNgn: suggestedFare,
            minOfferNgn: minFare,
            ratePerKmNgn: plannedRoute.ratePerKmNgn,
            route: plannedRoute.geometry,
          });
          await setBookingStage(deps.redisClient, user.id, 'awaiting_price');

          const editedLabel = bookingStage === 'editing_pickup' ? 'Pickup updated!' : 'Destination updated!';
          const reply = [
            `✅ *${editedLabel}*`,
            ``,
            `Pickup: *${pickup.address}*`,
            ``,
            `Destination: *${destination.address}*`,
            ``,
            `${distanceKm.toFixed(1)} km · ~${durationMin} min`,
            `Minimum fare: ₦${minFare.toLocaleString()}`,
            `Suggested fare: ₦${suggestedFare.toLocaleString()}`,
            ``,
            `Send your offer (e.g. *${suggestedFare.toLocaleString()}* or *${Math.round(suggestedFare * 0.85).toLocaleString()}*)`,
          ].join('\n');

          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: `[Shared location: ${address}]` },
            { role: 'assistant', content: reply },
          ]);
          await sendMetaReply(deps, phone, reply);
          return;
        }
      }

      const pendingPickup = await getPendingLocation(deps.redisClient, user.id);

      if (!pendingPickup) {
        // ── FIRST location pin = PICKUP ──
        await setPendingLocation(deps.redisClient, user.id, {
          lat: locationLat,
          lng: locationLng,
          address,
          savedAt: new Date().toISOString(),
        });
        await setBookingStage(deps.redisClient, user.id, 'awaiting_destination');

        const reply = `📍 Pickup: *${address}*\n\nNow share your *destination* location pin! 📍`;
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: `[Shared pickup location: ${address}]` },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }

      // ── SECOND location pin = DESTINATION ──
      // We have pickup, now got destination — go straight to finding drivers
      const pickup = { lat: pendingPickup.lat, lng: pendingPickup.lng, address: pendingPickup.address };
      const destination = { lat: locationLat, lng: locationLng, address };

      await clearPendingLocation(deps.redisClient, user.id);
      await clearBookingStage(deps.redisClient, user.id);

      // Check for existing active ride
      if (activeRideId) {
        const reply = 'You already have an active ride. Say *cancel* first to book a new one.';
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: `[Shared destination location: ${address}]` },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }

      // Plan route, store it, and ask rider for their price
      const plannedRoute = await deps.routePlanner.planRoute({ origin: pickup, destination });
      const distanceKm = plannedRoute.distanceKm;
      const durationMin = Math.ceil(plannedRoute.durationSeconds / 60);
      const suggestedFare = plannedRoute.suggestedFareNgn;
      const minFare = plannedRoute.minOfferNgn;

      await storePendingRoute(deps.redisClient, user.id, {
        pickupLat: pickup.lat,
        pickupLng: pickup.lng,
        pickupAddress: pickup.address,
        destLat: destination.lat,
        destLng: destination.lng,
        destAddress: destination.address,
        distanceKm,
        durationSeconds: plannedRoute.durationSeconds,
        suggestedFareNgn: suggestedFare,
        minOfferNgn: minFare,
        ratePerKmNgn: plannedRoute.ratePerKmNgn,
        route: plannedRoute.geometry,
      });
      await setBookingStage(deps.redisClient, user.id, 'awaiting_price');

      const reply = [
        `Pickup: *${pickup.address}*`,
        ``,
        `Destination: *${destination.address}*`,
        ``,
        `${distanceKm.toFixed(1)} km · ~${durationMin} min`,
        `Minimum fare: ₦${minFare.toLocaleString()}`,
        `Suggested fare: ₦${suggestedFare.toLocaleString()}`,
        ``,
        `Negotiate your price and we'll find you a driver!`,
        `Send your offer (e.g. *${suggestedFare.toLocaleString()}* or *${Math.round(suggestedFare * 0.85).toLocaleString()}*)`,
      ].join('\n');

      await appendWhatsappConversation(deps.redisClient, phone, [
        { role: 'user', content: `[Shared destination location: ${address}]` },
        { role: 'assistant', content: reply },
      ]);
      await sendMetaReply(deps, phone, reply);
      return;
    }

    // ══════════════════════════════════════════════════════════════════════
    // 3. AWAITING DESTINATION — user can type an address or share a pin
    // ══════════════════════════════════════════════════════════════════════

    if (bookingStage === 'awaiting_destination' && !isLocation) {
      if (isCancelCommand(incomingMessage)) {
        await setBookingStage(deps.redisClient, user.id, 'awaiting_cancel_reason');
        const reply = CANCELLATION_REASON_PROMPT;
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }

      const pendingPickup = await getPendingLocation(deps.redisClient, user.id);
      if (!pendingPickup) {
        await clearBookingStage(deps.redisClient, user.id);
        const reply = 'Session expired. Type your pickup and destination like:\n\n*"From [pickup] to [destination]"*\n\nOr share a location pin 📍';
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }

      // Try to geocode the typed destination
      const destGeo = await geocodeAddress(deps.googleMapsApiKey, incomingMessage.trim());
      if (!destGeo) {
        const reply = `Could not find "${incomingMessage.trim()}" on the map.\n\nPlease type a more specific destination address or share a location pin 📍`;
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }

      // Destination geocoded — plan route
      const pickup = { lat: pendingPickup.lat, lng: pendingPickup.lng, address: pendingPickup.address };
      const destination = { lat: destGeo.lat, lng: destGeo.lng, address: destGeo.formattedAddress };

      await clearPendingLocation(deps.redisClient, user.id);
      await clearBookingStage(deps.redisClient, user.id);

      const plannedRoute = await deps.routePlanner.planRoute({ origin: pickup, destination });
      const distanceKm = plannedRoute.distanceKm;
      const durationMin = Math.ceil(plannedRoute.durationSeconds / 60);
      const suggestedFare = plannedRoute.suggestedFareNgn;
      const minFare = plannedRoute.minOfferNgn;

      await storePendingRoute(deps.redisClient, user.id, {
        pickupLat: pickup.lat,
        pickupLng: pickup.lng,
        pickupAddress: pickup.address,
        destLat: destination.lat,
        destLng: destination.lng,
        destAddress: destination.address,
        distanceKm,
        durationSeconds: plannedRoute.durationSeconds,
        suggestedFareNgn: suggestedFare,
        minOfferNgn: minFare,
        ratePerKmNgn: plannedRoute.ratePerKmNgn,
        route: plannedRoute.geometry,
      });
      await setBookingStage(deps.redisClient, user.id, 'awaiting_price');

      const reply = [
        `Pickup: *${pickup.address}*`,
        ``,
        `Destination: *${destination.address}*`,
        ``,
        `${distanceKm.toFixed(1)} km · ~${durationMin} min`,
        `Minimum fare: ₦${minFare.toLocaleString()}`,
        `Suggested fare: ₦${suggestedFare.toLocaleString()}`,
        ``,
        `Negotiate your price and we'll find you a driver!`,
        `Send your offer (e.g. *${suggestedFare.toLocaleString()}* or *${Math.round(suggestedFare * 0.85).toLocaleString()}*)`,
      ].join('\n');

      await appendWhatsappConversation(deps.redisClient, phone, [
        { role: 'user', content: incomingMessage },
        { role: 'assistant', content: reply },
      ]);
      await sendMetaReply(deps, phone, reply);
      return;
    }

    // ══════════════════════════════════════════════════════════════════════
    // 3b. EDITING PICKUP / DESTINATION — user types an address
    // ══════════════════════════════════════════════════════════════════════

    if ((bookingStage === 'editing_pickup' || bookingStage === 'editing_destination') && !isLocation) {
      // Cancel during editing — clear everything
      if (isCancelCommand(incomingMessage)) {
        await setBookingStage(deps.redisClient, user.id, 'awaiting_cancel_reason');
        const reply = CANCELLATION_REASON_PROMPT;
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }

      const pendingRoute = await getPendingRoute(deps.redisClient, user.id);
      if (!pendingRoute) {
        await clearBookingStage(deps.redisClient, user.id);
        const reply = 'Session expired. Share a location pin to start a new booking 📍';
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }

      const geo = await geocodeAddress(deps.googleMapsApiKey, incomingMessage.trim());
      if (!geo) {
        const label = bookingStage === 'editing_pickup' ? 'pickup' : 'destination';
        const reply = `Could not find "${incomingMessage.trim()}" on the map.\n\nPlease type a more specific ${label} address or share a location pin 📍`;
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }

      const pickup = bookingStage === 'editing_pickup'
        ? { lat: geo.lat, lng: geo.lng, address: geo.formattedAddress }
        : { lat: pendingRoute.pickupLat, lng: pendingRoute.pickupLng, address: pendingRoute.pickupAddress };
      const destination = bookingStage === 'editing_destination'
        ? { lat: geo.lat, lng: geo.lng, address: geo.formattedAddress }
        : { lat: pendingRoute.destLat, lng: pendingRoute.destLng, address: pendingRoute.destAddress };

      const plannedRoute = await deps.routePlanner.planRoute({ origin: pickup, destination });
      const distanceKm = plannedRoute.distanceKm;
      const durationMin = Math.ceil(plannedRoute.durationSeconds / 60);
      const suggestedFare = plannedRoute.suggestedFareNgn;
      const minFare = plannedRoute.minOfferNgn;

      // If rider had an active ride, cancel it now that the edit succeeded
      if (activeRideId) {
        const cancelEvent = RideCancelledEvent.parse({
          eventType: 'RIDE_CANCELLED',
          rideId: activeRideId,
          riderId: user.id,
          reason: 'rider_editing_route',
          timestamp: new Date().toISOString(),
        });
        await deps.publisher.publishRideEvent(cancelEvent);
        await clearActiveRide(deps.redisClient, user.id);
        await cleanupRideKeys(deps.redisClient, activeRideId);
        await clearPendingAccept(deps.redisClient, user.id);
      }

      await storePendingRoute(deps.redisClient, user.id, {
        pickupLat: pickup.lat,
        pickupLng: pickup.lng,
        pickupAddress: pickup.address,
        destLat: destination.lat,
        destLng: destination.lng,
        destAddress: destination.address,
        distanceKm,
        durationSeconds: plannedRoute.durationSeconds,
        suggestedFareNgn: suggestedFare,
        minOfferNgn: minFare,
        ratePerKmNgn: plannedRoute.ratePerKmNgn,
        route: plannedRoute.geometry,
      });
      await setBookingStage(deps.redisClient, user.id, 'awaiting_price');

      const editedLabel = bookingStage === 'editing_pickup' ? 'Pickup updated!' : 'Destination updated!';
      const reply = [
        `✅ *${editedLabel}*`,
        ``,
        `Pickup: *${pickup.address}*`,
        ``,
        `Destination: *${destination.address}*`,
        ``,
        `${distanceKm.toFixed(1)} km · ~${durationMin} min`,
        `Minimum fare: ₦${minFare.toLocaleString()}`,
        `Suggested fare: ₦${suggestedFare.toLocaleString()}`,
        ``,
        `Send your offer (e.g. *${suggestedFare.toLocaleString()}* or *${Math.round(suggestedFare * 0.85).toLocaleString()}*)`,
      ].join('\n');

      await appendWhatsappConversation(deps.redisClient, phone, [
        { role: 'user', content: incomingMessage },
        { role: 'assistant', content: reply },
      ]);
      await sendMetaReply(deps, phone, reply);
      return;
    }

    // ══════════════════════════════════════════════════════════════════════
    // 4. AWAITING PRICE — user sends their offer after seeing route info
    // ══════════════════════════════════════════════════════════════════════

    if (bookingStage === 'awaiting_price' && !isLocation) {
      const pendingRoute = await getPendingRoute(deps.redisClient, user.id);
      if (pendingRoute) {
        // ── Direct edit commands: "edit pickup" / "edit destination" ──
        if (isEditPickupCommand(incomingMessage) || isEditDestinationCommand(incomingMessage)) {
          const isPickup = isEditPickupCommand(incomingMessage);
          const inlineAddress = extractEditAddress(incomingMessage);

          if (inlineAddress) {
            // Address provided inline — geocode and replan immediately
            const geo = await geocodeAddress(deps.googleMapsApiKey, inlineAddress);
            if (!geo) {
              const label = isPickup ? 'pickup' : 'destination';
              const reply = `Could not find "${inlineAddress}" on the map.\n\nPlease try a more specific ${label} address or share a location pin 📍`;
              await appendWhatsappConversation(deps.redisClient, phone, [
                { role: 'user', content: incomingMessage },
                { role: 'assistant', content: reply },
              ]);
              await sendMetaReply(deps, phone, reply);
              return;
            }

            const pickup = isPickup
              ? { lat: geo.lat, lng: geo.lng, address: geo.formattedAddress }
              : { lat: pendingRoute.pickupLat, lng: pendingRoute.pickupLng, address: pendingRoute.pickupAddress };
            const destination = !isPickup
              ? { lat: geo.lat, lng: geo.lng, address: geo.formattedAddress }
              : { lat: pendingRoute.destLat, lng: pendingRoute.destLng, address: pendingRoute.destAddress };

            const plannedRoute = await deps.routePlanner.planRoute({ origin: pickup, destination });
            const distanceKm = plannedRoute.distanceKm;
            const durationMin = Math.ceil(plannedRoute.durationSeconds / 60);
            const suggestedFare = plannedRoute.suggestedFareNgn;
            const minFare = plannedRoute.minOfferNgn;

            await storePendingRoute(deps.redisClient, user.id, {
              pickupLat: pickup.lat,
              pickupLng: pickup.lng,
              pickupAddress: pickup.address,
              destLat: destination.lat,
              destLng: destination.lng,
              destAddress: destination.address,
              distanceKm,
              durationSeconds: plannedRoute.durationSeconds,
              suggestedFareNgn: suggestedFare,
              minOfferNgn: minFare,
              ratePerKmNgn: plannedRoute.ratePerKmNgn,
              route: plannedRoute.geometry,
            });

            const editedLabel = isPickup ? 'Pickup updated!' : 'Destination updated!';
            const reply = [
              `✅ *${editedLabel}*`,
              ``,
              `Pickup: *${pickup.address}*`,
              ``,
              `Destination: *${destination.address}*`,
              ``,
              `${distanceKm.toFixed(1)} km · ~${durationMin} min`,
              `Minimum fare: ₦${minFare.toLocaleString()}`,
              `Suggested fare: ₦${suggestedFare.toLocaleString()}`,
              ``,
              `Send your offer (e.g. *${suggestedFare.toLocaleString()}* or *${Math.round(suggestedFare * 0.85).toLocaleString()}*)`,
            ].join('\n');

            await appendWhatsappConversation(deps.redisClient, phone, [
              { role: 'user', content: incomingMessage },
              { role: 'assistant', content: reply },
            ]);
            await sendMetaReply(deps, phone, reply);
            return;
          }

          // No inline address — ask for it
          const label = isPickup ? 'pickup' : 'destination';
          const current = isPickup ? pendingRoute.pickupAddress : pendingRoute.destAddress;
          await setBookingStage(deps.redisClient, user.id, isPickup ? 'editing_pickup' : 'editing_destination');
          const reply = `Current ${label}: *${current}*\n\nSend a new ${label} location pin 📍 or type the address.`;
          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: incomingMessage },
            { role: 'assistant', content: reply },
          ]);
          await sendMetaReply(deps, phone, reply);
          return;
        }

        // ── LLM fallback: "change pickup to XYZ" with address inline ──
        const recentMsgs = await getWhatsappConversation(deps.redisClient, phone);
        const groqForEdit = new GroqClient({
          apiKey: deps.groqApiKey,
          model: deps.groqModel,
          timeoutMs: deps.groqTimeoutMs,
        });
        const editIntent = await parseRideIntent(groqForEdit, incomingMessage, recentMsgs);

        if (editIntent?.intent === 'edit_pickup' && editIntent.pickup?.address.trim()) {
          const pickupGeo = await geocodeAddress(deps.googleMapsApiKey, editIntent.pickup.address);
          if (!pickupGeo) {
            const reply = `Could not find "${editIntent.pickup.address}" on the map.\n\nPlease try a more specific pickup address.`;
            await appendWhatsappConversation(deps.redisClient, phone, [
              { role: 'user', content: incomingMessage },
              { role: 'assistant', content: reply },
            ]);
            await sendMetaReply(deps, phone, reply);
            return;
          }

          const pickup = { lat: pickupGeo.lat, lng: pickupGeo.lng, address: pickupGeo.formattedAddress };
          const destination = { lat: pendingRoute.destLat, lng: pendingRoute.destLng, address: pendingRoute.destAddress };

          const plannedRoute = await deps.routePlanner.planRoute({ origin: pickup, destination });
          const distanceKm = plannedRoute.distanceKm;
          const durationMin = Math.ceil(plannedRoute.durationSeconds / 60);
          const suggestedFare = plannedRoute.suggestedFareNgn;
          const minFare = plannedRoute.minOfferNgn;

          await storePendingRoute(deps.redisClient, user.id, {
            pickupLat: pickup.lat,
            pickupLng: pickup.lng,
            pickupAddress: pickup.address,
            destLat: destination.lat,
            destLng: destination.lng,
            destAddress: destination.address,
            distanceKm,
            durationSeconds: plannedRoute.durationSeconds,
            suggestedFareNgn: suggestedFare,
            minOfferNgn: minFare,
            ratePerKmNgn: plannedRoute.ratePerKmNgn,
            route: plannedRoute.geometry,
          });

          const reply = [
            `Pickup: *${pickup.address}*`,
            ``,
            `Destination: *${destination.address}*`,
            ``,
            `${distanceKm.toFixed(1)} km · ~${durationMin} min`,
            `Minimum fare: ₦${minFare.toLocaleString()}`,
            `Suggested fare: ₦${suggestedFare.toLocaleString()}`,
            ``,
            `Negotiate your price and we'll find you a driver!`,
            `Send your offer (e.g. *${suggestedFare.toLocaleString()}* or *${Math.round(suggestedFare * 0.85).toLocaleString()}*)`,
          ].join('\n');

          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: incomingMessage },
            { role: 'assistant', content: reply },
          ]);
          await sendMetaReply(deps, phone, reply);
          return;
        }

        if (editIntent?.intent === 'edit_destination' && editIntent.destination?.address.trim()) {
          const destGeo = await geocodeAddress(deps.googleMapsApiKey, editIntent.destination.address);
          if (!destGeo) {
            const reply = `Could not find "${editIntent.destination.address}" on the map.\n\nPlease try a more specific destination address.`;
            await appendWhatsappConversation(deps.redisClient, phone, [
              { role: 'user', content: incomingMessage },
              { role: 'assistant', content: reply },
            ]);
            await sendMetaReply(deps, phone, reply);
            return;
          }

          const pickup = { lat: pendingRoute.pickupLat, lng: pendingRoute.pickupLng, address: pendingRoute.pickupAddress };
          const destination = { lat: destGeo.lat, lng: destGeo.lng, address: destGeo.formattedAddress };

          const plannedRoute = await deps.routePlanner.planRoute({ origin: pickup, destination });
          const distanceKm = plannedRoute.distanceKm;
          const durationMin = Math.ceil(plannedRoute.durationSeconds / 60);
          const suggestedFare = plannedRoute.suggestedFareNgn;
          const minFare = plannedRoute.minOfferNgn;

          await storePendingRoute(deps.redisClient, user.id, {
            pickupLat: pickup.lat,
            pickupLng: pickup.lng,
            pickupAddress: pickup.address,
            destLat: destination.lat,
            destLng: destination.lng,
            destAddress: destination.address,
            distanceKm,
            durationSeconds: plannedRoute.durationSeconds,
            suggestedFareNgn: suggestedFare,
            minOfferNgn: minFare,
            ratePerKmNgn: plannedRoute.ratePerKmNgn,
            route: plannedRoute.geometry,
          });

          const reply = [
            `Pickup: *${pickup.address}*`,
            ``,
            `Destination: *${destination.address}*`,
            ``,
            `${distanceKm.toFixed(1)} km · ~${durationMin} min`,
            `Minimum fare: ₦${minFare.toLocaleString()}`,
            `Suggested fare: ₦${suggestedFare.toLocaleString()}`,
            ``,
            `Negotiate your price and we'll find you a driver!`,
            `Send your offer (e.g. *${suggestedFare.toLocaleString()}* or *${Math.round(suggestedFare * 0.85).toLocaleString()}*)`,
          ].join('\n');

          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: incomingMessage },
            { role: 'assistant', content: reply },
          ]);
          await sendMetaReply(deps, phone, reply);
          return;
        }

        // ── Cancel during awaiting_price ──
        if (isCancelCommand(incomingMessage)) {
          await setBookingStage(deps.redisClient, user.id, 'awaiting_cancel_reason');
          const reply = CANCELLATION_REASON_PROMPT;
          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: incomingMessage },
            { role: 'assistant', content: reply },
          ]);
          await sendMetaReply(deps, phone, reply);
          return;
        }

        const offerNgn = parseCounterOffer(incomingMessage);

        if (offerNgn === null) {
          const reply = `Please send a price for your ride.\n\nMinimum: ₦${pendingRoute.minOfferNgn.toLocaleString()}\nSuggested: ₦${pendingRoute.suggestedFareNgn.toLocaleString()}\n\nExample: *${pendingRoute.suggestedFareNgn.toLocaleString()}*`;
          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: incomingMessage },
            { role: 'assistant', content: reply },
          ]);
          await sendMetaReply(deps, phone, reply);
          return;
        }

        if (offerNgn < pendingRoute.minOfferNgn) {
          const reply = `Your offer ₦${offerNgn.toLocaleString()} is below the minimum fare of ₦${pendingRoute.minOfferNgn.toLocaleString()}.\n\nPlease send a higher amount.`;
          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: incomingMessage },
            { role: 'assistant', content: reply },
          ]);
          await sendMetaReply(deps, phone, reply);
          return;
        }

        // Publish ride — payment happens when rider accepts a driver
        const rideId = randomUUID();

        await clearPendingRoute(deps.redisClient, user.id);
        await clearBookingStage(deps.redisClient, user.id);

        const event = RideRequestedEvent.parse({
          eventType: 'RIDE_REQUESTED',
          rideId,
          riderId: user.id,
          pickup: { lat: pendingRoute.pickupLat, lng: pendingRoute.pickupLng, address: pendingRoute.pickupAddress },
          destination: { lat: pendingRoute.destLat, lng: pendingRoute.destLng, address: pendingRoute.destAddress },
          stops: [],
          plannedDistanceKm: pendingRoute.distanceKm,
          plannedDurationSeconds: pendingRoute.durationSeconds,
          fareEstimateNgn: offerNgn,
          paymentMethod: 'WALLET',
          riderOfferNgn: offerNgn,
          suggestedFareNgn: pendingRoute.suggestedFareNgn,
          minOfferNgn: pendingRoute.minOfferNgn,
          ratePerKmNgn: pendingRoute.ratePerKmNgn,
          route: pendingRoute.route,
          timestamp: new Date().toISOString(),
        });

        await deps.publisher.publishRideEvent(event);

        await storeWhatsappRide(deps.redisClient, rideId, {
          riderId: user.id,
          phone,
          pickupAddress: pendingRoute.pickupAddress,
          pickupLat: pendingRoute.pickupLat,
          pickupLng: pendingRoute.pickupLng,
          destinationAddress: pendingRoute.destAddress,
          destinationLat: pendingRoute.destLat,
          destinationLng: pendingRoute.destLng,
          distanceKm: pendingRoute.distanceKm,
          durationSeconds: pendingRoute.durationSeconds,
          offerNgn,
          suggestedFareNgn: pendingRoute.suggestedFareNgn,
          paymentMethod: 'WALLET',
          createdAt: new Date().toISOString(),
        });
        await setActiveRide(deps.redisClient, user.id, rideId);

        const reply = [
          `🔍 *Finding you a driver!*`,
          ``,
          `Pickup: *${pendingRoute.pickupAddress}*`,
          `Destination: *${pendingRoute.destAddress}*`,
          `Your offer: ₦${offerNgn.toLocaleString()}`,
          ``,
          `We'll send you available drivers — pick one and pay to confirm! 🚗`,
        ].join('\n');

        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }
    }

    // ══════════════════════════════════════════════════════════════════════
    // 5. CANCEL RIDE (via LLM intent or direct text, no active ride)
    // ══════════════════════════════════════════════════════════════════════

    if (isCancelCommand(incomingMessage)) {
      // Clear any pending state
      await clearPendingLocation(deps.redisClient, user.id);
      await clearBookingStage(deps.redisClient, user.id);
      await clearPendingRoute(deps.redisClient, user.id);

      const reply = 'Nothing to cancel. Share your location to book a ride! 📍';
      await appendWhatsappConversation(deps.redisClient, phone, [
        { role: 'user', content: incomingMessage },
        { role: 'assistant', content: reply },
      ]);
      await sendMetaReply(deps, phone, reply);
      return;
    }

    // ══════════════════════════════════════════════════════════════════════
    // 6. NO ACTIVE RIDE, NO PENDING STATE — AI conversation / ride intent
    // ══════════════════════════════════════════════════════════════════════

    const recentMessages = await getWhatsappConversation(deps.redisClient, phone);

    const groq = new GroqClient({
      apiKey: deps.groqApiKey,
      model: deps.groqModel,
      timeoutMs: deps.groqTimeoutMs,
    });

    // Try to parse ride intent
    const rideIntent = await parseRideIntent(groq, incomingMessage, recentMessages);

    // ── Edit pickup/destination with no pending route → tell user to start fresh ──
    if (rideIntent?.intent === 'edit_pickup' || rideIntent?.intent === 'edit_destination') {
      const reply = 'No ride in progress to edit. Start a new ride by typing:\n\n*"From [pickup] to [destination]"*\n\nOr share a location pin 📍';
      await appendWhatsappConversation(deps.redisClient, phone, [
        { role: 'user', content: incomingMessage },
        { role: 'assistant', content: reply },
      ]);
      await sendMetaReply(deps, phone, reply);
      return;
    }

    if (rideIntent?.intent === 'ride_request') {
      const hasPickup = rideIntent.pickup?.specific && rideIntent.pickup.address.trim();
      const hasDestination = rideIntent.destination?.specific && rideIntent.destination.address.trim();

      // ── Both pickup & destination typed → geocode both and plan route ──
      if (hasPickup && hasDestination) {
        const [pickupGeo, destGeo] = await Promise.all([
          geocodeAddress(deps.googleMapsApiKey, rideIntent.pickup!.address),
          geocodeAddress(deps.googleMapsApiKey, rideIntent.destination!.address),
        ]);

        if (!pickupGeo) {
          const reply = `Could not find "${rideIntent.pickup!.address}" on the map.\n\nPlease try a more specific pickup address, or share a location pin 📍`;
          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: incomingMessage },
            { role: 'assistant', content: reply },
          ]);
          await sendMetaReply(deps, phone, reply);
          return;
        }

        if (!destGeo) {
          // Pickup worked — save it and ask for destination again
          await setPendingLocation(deps.redisClient, user.id, {
            lat: pickupGeo.lat,
            lng: pickupGeo.lng,
            address: pickupGeo.formattedAddress,
            savedAt: new Date().toISOString(),
          });
          await setBookingStage(deps.redisClient, user.id, 'awaiting_destination');

          const reply = `📍 Pickup: *${pickupGeo.formattedAddress}*\n\nCould not find "${rideIntent.destination!.address}" on the map.\n\nPlease type a more specific destination or share a destination location pin 📍`;
          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: incomingMessage },
            { role: 'assistant', content: reply },
          ]);
          await sendMetaReply(deps, phone, reply);
          return;
        }

        // Both geocoded — plan route and ask for price
        const pickup = { lat: pickupGeo.lat, lng: pickupGeo.lng, address: pickupGeo.formattedAddress };
        const destination = { lat: destGeo.lat, lng: destGeo.lng, address: destGeo.formattedAddress };

        const plannedRoute = await deps.routePlanner.planRoute({ origin: pickup, destination });
        const distanceKm = plannedRoute.distanceKm;
        const durationMin = Math.ceil(plannedRoute.durationSeconds / 60);
        const suggestedFare = plannedRoute.suggestedFareNgn;
        const minFare = plannedRoute.minOfferNgn;

        await storePendingRoute(deps.redisClient, user.id, {
          pickupLat: pickup.lat,
          pickupLng: pickup.lng,
          pickupAddress: pickup.address,
          destLat: destination.lat,
          destLng: destination.lng,
          destAddress: destination.address,
          distanceKm,
          durationSeconds: plannedRoute.durationSeconds,
          suggestedFareNgn: suggestedFare,
          minOfferNgn: minFare,
          ratePerKmNgn: plannedRoute.ratePerKmNgn,
          route: plannedRoute.geometry,
        });

        // If rider already included a price and it meets minimum, skip awaiting_price
        if (rideIntent.offerNgn && rideIntent.offerNgn >= minFare) {
          await clearPendingRoute(deps.redisClient, user.id);

          const rideId = randomUUID();
          const event = RideRequestedEvent.parse({
            eventType: 'RIDE_REQUESTED',
            rideId,
            riderId: user.id,
            pickup,
            destination,
            stops: [],
            plannedDistanceKm: distanceKm,
            plannedDurationSeconds: plannedRoute.durationSeconds,
            fareEstimateNgn: suggestedFare,
            paymentMethod: 'WALLET',
            riderOfferNgn: rideIntent.offerNgn,
            suggestedFareNgn: suggestedFare,
            minOfferNgn: minFare,
            ratePerKmNgn: plannedRoute.ratePerKmNgn,
            route: plannedRoute.geometry,
            timestamp: new Date().toISOString(),
          });

          await deps.publisher.publishRideEvent(event);

          await storeWhatsappRide(deps.redisClient, rideId, {
            riderId: user.id,
            phone,
            pickupAddress: pickup.address,
            pickupLat: pickup.lat,
            pickupLng: pickup.lng,
            destinationAddress: destination.address,
            destinationLat: destination.lat,
            destinationLng: destination.lng,
            distanceKm,
            durationSeconds: plannedRoute.durationSeconds,
            offerNgn: rideIntent.offerNgn,
            suggestedFareNgn: suggestedFare,
            paymentMethod: 'WALLET',
            createdAt: new Date().toISOString(),
          });
          await setActiveRide(deps.redisClient, user.id, rideId);

          const reply = [
            `🔍 *Finding you a driver!*`,
            ``,
            `Pickup: *${pickup.address}*`,
            `Destination: *${destination.address}*`,
            `${distanceKm.toFixed(1)} km · ~${durationMin} min`,
            `Your offer: ₦${rideIntent.offerNgn.toLocaleString()}`,
            ``,
            `We'll send you all available drivers! 🚗`,
          ].join('\n');

          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: incomingMessage },
            { role: 'assistant', content: reply },
          ]);
          await sendMetaReply(deps, phone, reply);
          return;
        }

        await setBookingStage(deps.redisClient, user.id, 'awaiting_price');

        const reply = [
          `Pickup: *${pickup.address}*`,
          ``,
          `Destination: *${destination.address}*`,
          ``,
          `${distanceKm.toFixed(1)} km · ~${durationMin} min`,
          `Minimum fare: ₦${minFare.toLocaleString()}`,
          `Suggested fare: ₦${suggestedFare.toLocaleString()}`,
          ``,
          `Negotiate your price and we'll find you a driver!`,
          `Send your offer (e.g. *${suggestedFare.toLocaleString()}* or *${Math.round(suggestedFare * 0.85).toLocaleString()}*)`,
        ].join('\n');

        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }

      // ── Only pickup typed → save it, ask for destination ──
      if (hasPickup) {
        const pickupGeo = await geocodeAddress(deps.googleMapsApiKey, rideIntent.pickup!.address);
        if (pickupGeo) {
          await setPendingLocation(deps.redisClient, user.id, {
            lat: pickupGeo.lat,
            lng: pickupGeo.lng,
            address: pickupGeo.formattedAddress,
            savedAt: new Date().toISOString(),
          });
          await setBookingStage(deps.redisClient, user.id, 'awaiting_destination');

          const reply = `📍 Pickup: *${pickupGeo.formattedAddress}*\n\nNow send your *destination* — type the address or share a location pin 📍`;
          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: incomingMessage },
            { role: 'assistant', content: reply },
          ]);
          await sendMetaReply(deps, phone, reply);
          return;
        }
      }

      // ── Only destination typed, or addresses not specific enough → ask for pickup ──
      const reply = 'To book a ride, type your pickup and destination like:\n\n*"From [pickup address] to [destination]"*\n\nOr share your pickup location pin 📍';
      await appendWhatsappConversation(deps.redisClient, phone, [
        { role: 'user', content: incomingMessage },
        { role: 'assistant', content: reply },
      ]);
      await sendMetaReply(deps, phone, reply);
      return;
    }

    // Ignore empty messages (stickers, images, etc.) — don't send to LLM
    if (!incomingMessage.trim()) {
      return;
    }

    // AI response for general messages
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

    await sendMetaReply(deps, phone, reply);
  } catch (error) {
    console.error('[whatsapp] webhook handling failed', error);
    // Don't try to send error — we already responded 200
  }
}
