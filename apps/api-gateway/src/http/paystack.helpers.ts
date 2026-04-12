import { createHash, createHmac, randomUUID } from 'node:crypto';
import { DepositReceivedEvent } from '@wheleers/kafka-schemas';
import { asIsoTimestamp, isRecord, pickNumber, pickString } from '../utils/object';

export interface PaystackFundingMetadata {
  userId: string;
  walletAddress: string;
  initiatedBy: 'api-gateway';
}

export function buildPaystackReference(userId: string): string {
  return `wheelers_${userId.replace(/-/g, '')}_${Date.now()}_${randomUUID().slice(0, 8)}`;
}

export function buildPaystackMetadata(input: {
  userId: string;
  walletAddress: string;
}): PaystackFundingMetadata {
  return {
    userId: input.userId,
    walletAddress: input.walletAddress.toLowerCase(),
    initiatedBy: 'api-gateway',
  };
}

export function readPaystackMetadata(value: unknown): PaystackFundingMetadata | null {
  const metadata = parseMetadata(value);
  if (!metadata) return null;

  const userId = typeof metadata['userId'] === 'string' ? metadata['userId'] : null;
  const walletAddress =
    typeof metadata['walletAddress'] === 'string' ? metadata['walletAddress'] : null;

  if (!userId || !walletAddress) {
    return null;
  }

  return {
    userId,
    walletAddress: walletAddress.toLowerCase(),
    initiatedBy: 'api-gateway',
  };
}

export function verifyPaystackSignature(
  rawBody: Buffer,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature) return false;

  const expected = createHmac('sha512', secret).update(rawBody).digest('hex');
  return expected === signature;
}

export function normalizePaystackChargeSuccess(input: unknown): DepositReceivedEvent | null {
  const payload = isRecord(input) ? input : null;
  if (!payload) return null;

  const metadata = readPaystackMetadata(payload['metadata']);
  const reference = pickString(payload, ['reference']);
  const amountMinor = pickNumber(payload, ['amount']);
  const currency = pickString(payload, ['currency'])?.toUpperCase() ?? 'NGN';
  const status = pickString(payload, ['status']);

  if (!metadata || !reference || !amountMinor || status !== 'success' || currency !== 'NGN') {
    return null;
  }

  const amountNgn = amountMinor / 100;

  return DepositReceivedEvent.parse({
    eventType: 'DEPOSIT_RECEIVED',
    paymentId: deterministicPaymentId(reference),
    userId: metadata.userId,
    paymentProvider: 'paystack',
    amountNgn,
    providerReference: reference,
    paymentChannel: pickString(payload, ['channel']) ?? undefined,
    customerEmail: pickString(payload, ['customer.email']) ?? undefined,
    virtualAccountNumber:
      pickString(payload, [
        'authorization.receiver_bank_account_number',
        'authorization.account_number',
      ]) ?? undefined,
    userWallet: metadata.walletAddress,
    timestamp: asIsoTimestamp(
      pickString(payload, ['paid_at', 'transaction_date', 'created_at']) ?? new Date().toISOString(),
    ),
  });
}

function parseMetadata(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) {
    return value;
  }

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  return null;
}

function deterministicPaymentId(reference: string): string {
  const hash = createHash('sha256').update(reference).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
