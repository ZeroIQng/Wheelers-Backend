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
      case 'inbound_transfer.received':
      case 'virtual_account.credited':
        await handleVirtualAccountCredited(data, deps.publisher);
        break;

      case 'payout.completed':
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
    'virtualAccount.id',
    'virtual_account.id',
    'destinationVirtualAccountId',
    'destination_virtual_account_id',
    'account.id',
    'account.uuid',
    'walletId',
    'wallet_id',
    'data.virtualAccountId',
  ]);
  const accountNumber = pickString(data, [
    'accountNumber',
    'account_number',
    'virtualAccount.accountNumber',
    'virtual_account.account_number',
    'creditedAccountNumber',
    'credited_account_number',
  ]);
  const rawAmount = pickNumber(data, ['amount', 'amountNgn', 'data.amount']);
  // Pouch/Liquifia sends amounts in kobo (minor units) — convert to NGN
  const amount = rawAmount != null ? rawAmount / 100 : undefined;
  const providerReference = pickString(data, [
    'reference',
    'providerReference',
    'transactionReference',
    'transaction_reference',
    'transferId',
    'transfer_id',
    'transactionId',
    'transaction_id',
    'paymentReference',
    'payment_reference',
    'eventId',
    'event_id',
    'id',
    'data.reference',
  ]);

  if ((!pouchVaId && !accountNumber) || !amount || !providerReference) {
    console.warn('[api-gateway][pouch-webhook] virtual_account.credited missing fields', {
      pouchVaId: pouchVaId ?? null,
      accountNumber: accountNumber ?? null,
      amount: amount ?? null,
      providerReference: providerReference ?? null,
    });
    return;
  }

  const virtualAccount = pouchVaId
    ? await virtualAccountClient.findByPouchVirtualAccountId(pouchVaId)
    : await virtualAccountClient.findByAccountNumber(accountNumber!);
  if (!virtualAccount) {
    console.warn('[api-gateway][pouch-webhook] virtual account not found', {
      pouchVaId: pouchVaId ?? null,
      accountNumber: accountNumber ?? null,
    });
    return;
  }

  const event: VirtualAccountCreditedEvent = {
    eventType: 'VIRTUAL_ACCOUNT_CREDITED',
    userId: virtualAccount.userId,
    pouchVirtualAccountId: virtualAccount.pouchVirtualAccountId,
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
    'transactionReference',
    'transaction_reference',
    'payoutReference',
    'payout_reference',
    'data.reference',
  ]);
  const pouchPayoutId = pickString(data, [
    'payoutId',
    'pouchPayoutId',
    'payout_id',
    'id',
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

function getWebhookSignature(
  req: IncomingMessage,
): { value: string; algorithm: 'sha512' | 'sha256' } | null {
  const liquifiaHeader = req.headers['x-liquifia-signature'];
  if (typeof liquifiaHeader === 'string' && liquifiaHeader.trim().length > 0) {
    return { value: liquifiaHeader.trim(), algorithm: 'sha512' };
  }

  if (Array.isArray(liquifiaHeader)) {
    const first = liquifiaHeader.find((value) => typeof value === 'string' && value.trim().length > 0);
    if (first) return { value: first.trim(), algorithm: 'sha512' };
  }

  // Backward compatibility with the previous internal webhook contract.
  const header = req.headers['x-webhook-signature'];
  if (typeof header === 'string' && header.trim().length > 0) {
    return { value: header.trim(), algorithm: 'sha256' };
  }

  if (Array.isArray(header)) {
    const first = header.find((value) => typeof value === 'string' && value.trim().length > 0);
    return first ? { value: first.trim(), algorithm: 'sha256' } : null;
  }

  return null;
}

function isValidWebhookSignature(
  rawBody: Buffer,
  signature: { value: string; algorithm: 'sha512' | 'sha256' } | null,
  secret: string,
): boolean {
  if (!signature) return false;

  const prefix = `${signature.algorithm}=`;
  const normalizedSignature = signature.value.startsWith(prefix)
    ? signature.value.slice(prefix.length)
    : signature.value;
  const expected = createHmac(signature.algorithm, secret).update(rawBody).digest();

  try {
    const provided = /^[0-9a-f]+$/i.test(normalizedSignature)
      ? Buffer.from(normalizedSignature, 'hex')
      : Buffer.from(normalizedSignature, 'base64');

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
    pickString(payload, ['event_name']) ??
    pickString(payload, ['data.event', 'data.eventType', 'data.event_name']) ??
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
