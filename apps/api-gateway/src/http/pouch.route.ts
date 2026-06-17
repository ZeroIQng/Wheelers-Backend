import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import { withdrawalClient, virtualAccountClient } from '@wheleers/db';
import type {
  VirtualAccountCreditedEvent,
  PayoutCompletedEvent,
  PayoutFailedEvent,
} from '@wheleers/kafka-schemas';
import type { GatewayPublisher } from '../websocket/publisher';
import { isRecord, pickNumber, pickString } from '../utils/object';
import { parseJsonBuffer, readRawBody, sendJson } from './utils';

/* ------------------------------------------------------------------ */
/*  Dependencies                                                      */
/* ------------------------------------------------------------------ */

export interface PouchWebhookRouteDeps {
  publisher: GatewayPublisher;
  webhookSecret?: string;
}

/* ------------------------------------------------------------------ */
/*  Health check (Pouch Liquifia)                                     */
/* ------------------------------------------------------------------ */

export async function handlePouchLiquifiaHealthRoute(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  sendJson(res, 200, { provider: 'pouch-liquifia', status: 'ok' });
}

/* ------------------------------------------------------------------ */
/*  Webhook handler                                                   */
/* ------------------------------------------------------------------ */

export async function handlePouchWebhookRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: PouchWebhookRouteDeps,
): Promise<void> {
  try {
    if (!deps.webhookSecret) {
      console.error('[api-gateway][pouch-webhook] secret not configured');
      sendJson(res, 503, { error: 'POUCH_WEBHOOK_SECRET is not configured' });
      return;
    }

    /* ---------- signature verification ---------- */

    const rawBody = await readRawBody(req);
    const signature = getWebhookSignature(req);

    if (!signature) {
      console.warn('[api-gateway][pouch-webhook] missing signature header');
      sendJson(res, 401, { error: 'Missing webhook signature' });
      return;
    }

    if (!isValidWebhookSignature(rawBody, signature, deps.webhookSecret)) {
      console.warn('[api-gateway][pouch-webhook] invalid signature');
      sendJson(res, 401, { error: 'Invalid webhook signature' });
      return;
    }

    /* ---------- parse body ---------- */

    const parsedBody = parseJsonBuffer(rawBody);
    if (!isRecord(parsedBody)) {
      sendJson(res, 400, { error: 'Webhook body must be a JSON object' });
      return;
    }

    const eventName = extractEventName(parsedBody);

    console.log('[api-gateway][pouch-webhook] received', { eventName: eventName ?? null });

    if (!eventName) {
      sendJson(res, 200, { received: true, processed: false, reason: 'Missing event name' });
      return;
    }

    /* ---------- dispatch by event type ---------- */

    const data = unwrapData(parsedBody);

    switch (eventName) {
      case 'virtual_account.credited':
        await handleVirtualAccountCredited(data, deps.publisher);
        break;

      case 'payout.success':
        await handlePayoutSuccess(data, deps.publisher);
        break;

      case 'payout.failed':
        await handlePayoutFailed(data, deps.publisher);
        break;

      default:
        console.log('[api-gateway][pouch-webhook] unhandled event type', { eventName });
        sendJson(res, 200, { received: true, processed: false, reason: `Unhandled event: ${eventName}` });
        return;
    }

    sendJson(res, 200, { received: true, processed: true });
  } catch (error) {
    console.error('[api-gateway][pouch-webhook] route error', {
      message: error instanceof Error ? error.message : String(error),
    });
    sendJson(res, 500, { error: 'Failed to process Pouch webhook' });
  }
}

/* ------------------------------------------------------------------ */
/*  Event handlers                                                    */
/* ------------------------------------------------------------------ */

async function handleVirtualAccountCredited(
  data: Record<string, unknown>,
  publisher: GatewayPublisher,
): Promise<void> {
  const pouchVaId = pickString(data, [
    'virtualAccountId',
    'virtual_account_id',
    'data.virtualAccountId',
  ]);
  const amount = pickNumber(data, ['amount', 'amountNgn', 'data.amount']);
  const providerReference = pickString(data, [
    'reference',
    'providerReference',
    'data.reference',
  ]);

  if (!pouchVaId || !amount || !providerReference) {
    console.warn('[api-gateway][pouch-webhook] virtual_account.credited missing fields', {
      pouchVaId: pouchVaId ?? null,
      amount: amount ?? null,
      providerReference: providerReference ?? null,
    });
    return;
  }

  const virtualAccount = await virtualAccountClient.findByPouchVirtualAccountId(pouchVaId);
  if (!virtualAccount) {
    console.warn('[api-gateway][pouch-webhook] virtual account not found', { pouchVaId });
    return;
  }

  const event: VirtualAccountCreditedEvent = {
    eventType: 'VIRTUAL_ACCOUNT_CREDITED',
    userId: virtualAccount.userId,
    pouchVirtualAccountId: pouchVaId,
    amountNgn: amount,
    bankName: pickString(data, ['bankName', 'bank_name', 'senderBankName']) ?? undefined,
    senderAccountNumber: pickString(data, ['senderAccountNumber', 'sender_account_number']) ?? undefined,
    senderAccountName: pickString(data, ['senderAccountName', 'sender_account_name']) ?? undefined,
    providerReference,
    timestamp: new Date().toISOString(),
  };

  await publisher.publishPaymentEvent(event);

  console.log('[api-gateway][pouch-webhook] virtual_account.credited processed', {
    userId: virtualAccount.userId,
    amountNgn: amount,
    providerReference,
  });
}

async function handlePayoutSuccess(
  data: Record<string, unknown>,
  publisher: GatewayPublisher,
): Promise<void> {
  const providerReference = pickString(data, [
    'reference',
    'providerReference',
    'data.reference',
  ]);
  const pouchPayoutId = pickString(data, [
    'payoutId',
    'pouchPayoutId',
    'data.payoutId',
  ]);

  if (!providerReference) {
    console.warn('[api-gateway][pouch-webhook] payout.success missing providerReference');
    return;
  }

  const withdrawal = await withdrawalClient.findByProviderReference(providerReference);
  if (!withdrawal) {
    console.warn('[api-gateway][pouch-webhook] withdrawal not found for payout.success', {
      providerReference,
    });
    return;
  }

  await withdrawalClient.settle(providerReference);

  const event: PayoutCompletedEvent = {
    eventType: 'PAYOUT_COMPLETED',
    userId: withdrawal.userId,
    pouchPayoutId: pouchPayoutId ?? withdrawal.pouchPayoutId ?? providerReference,
    providerReference,
    amountNgn: Number(withdrawal.requestedAmountNgn),
    timestamp: new Date().toISOString(),
  };

  await publisher.publishPaymentEvent(event);

  console.log('[api-gateway][pouch-webhook] payout.success processed', {
    userId: withdrawal.userId,
    withdrawalId: withdrawal.id,
    providerReference,
  });
}

async function handlePayoutFailed(
  data: Record<string, unknown>,
  publisher: GatewayPublisher,
): Promise<void> {
  const providerReference = pickString(data, [
    'reference',
    'providerReference',
    'data.reference',
  ]);
  const pouchPayoutId = pickString(data, [
    'payoutId',
    'pouchPayoutId',
    'data.payoutId',
  ]);
  const failureReason = pickString(data, [
    'reason',
    'failureReason',
    'data.reason',
    'message',
  ]) ?? 'Payout failed';

  if (!providerReference) {
    console.warn('[api-gateway][pouch-webhook] payout.failed missing providerReference');
    return;
  }

  const withdrawal = await withdrawalClient.findByProviderReference(providerReference);
  if (!withdrawal) {
    console.warn('[api-gateway][pouch-webhook] withdrawal not found for payout.failed', {
      providerReference,
    });
    return;
  }

  await withdrawalClient.releaseFailedRequest({
    providerReference,
    failureReason,
    status: 'FAILED',
  });

  const event: PayoutFailedEvent = {
    eventType: 'PAYOUT_FAILED',
    userId: withdrawal.userId,
    pouchPayoutId: pouchPayoutId ?? withdrawal.pouchPayoutId ?? providerReference,
    providerReference,
    failureReason,
    timestamp: new Date().toISOString(),
  };

  await publisher.publishPaymentEvent(event);

  console.log('[api-gateway][pouch-webhook] payout.failed processed', {
    userId: withdrawal.userId,
    withdrawalId: withdrawal.id,
    providerReference,
    failureReason,
  });
}

/* ------------------------------------------------------------------ */
/*  Webhook helpers                                                   */
/* ------------------------------------------------------------------ */

function getWebhookSignature(req: IncomingMessage): string | null {
  const header = req.headers['x-webhook-signature'];
  if (typeof header === 'string' && header.trim().length > 0) {
    return header.trim();
  }

  if (Array.isArray(header)) {
    const first = header.find((value) => typeof value === 'string' && value.trim().length > 0);
    return first?.trim() ?? null;
  }

  return null;
}

function isValidWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string,
  secret: string,
): boolean {
  const expectedHex = createHmac('sha256', secret).update(rawBody).digest('hex');
  const normalizedSignature = signatureHeader.startsWith('sha256=')
    ? signatureHeader.slice('sha256='.length)
    : signatureHeader;

  try {
    const provided = Buffer.from(normalizedSignature, 'hex');
    const expected = Buffer.from(expectedHex, 'hex');

    if (provided.length !== expected.length) {
      return false;
    }

    return timingSafeEqual(provided, expected);
  } catch {
    return false;
  }
}

function extractEventName(payload: Record<string, unknown>): string | null {
  return (
    pickString(payload, ['event', 'eventType', 'type']) ??
    pickString(payload, ['data.event', 'data.eventType']) ??
    null
  );
}

function unwrapData(payload: Record<string, unknown>): Record<string, unknown> {
  const nested =
    (isRecord(payload['data']) && payload['data']) ||
    (isRecord(payload['payload']) && payload['payload']);

  if (!nested) {
    return payload;
  }

  return { ...payload, ...nested };
}
