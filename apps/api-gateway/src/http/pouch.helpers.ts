import { createHash } from 'node:crypto';
import {
  OnrampSettledEvent,
  PaymentSessionCreatedEvent,
} from '@wheleers/kafka-schemas';
import { asIsoTimestamp, isRecord, pickNumber, pickString } from '../utils/object';

const SETTLED_STATUSES = new Set([
  'COMPLETED',
  'COMPLETE',
  'SUCCESS',
  'SUCCEEDED',
  'PAID',
  'SETTLED',
  'FUNDED',
]);

export interface PouchFundingMetadata {
  userId: string;
  walletAddress: string;
  initiatedBy: 'api-gateway';
}

export function buildPouchMetadata(input: {
  userId: string;
  walletAddress: string;
}): PouchFundingMetadata {
  return {
    userId: input.userId,
    walletAddress: input.walletAddress.toLowerCase(),
    initiatedBy: 'api-gateway',
  };
}

export function readPouchMetadata(value: unknown): PouchFundingMetadata | null {
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

export function pouchSessionBelongsToUser(
  session: unknown,
  userId: string,
): boolean {
  const payload = isRecord(session) ? session : null;
  if (!payload) return false;

  const metadata = readPouchMetadata(payload['metadata']);
  if (!metadata) {
    return true;
  }

  return metadata.userId === userId;
}

export function normalizePouchSessionCreated(input: unknown): PaymentSessionCreatedEvent | null {
  const payload = isRecord(input) ? input : null;
  if (!payload) return null;

  const metadata = readPouchMetadata(payload['metadata']);
  const providerReference = pickString(payload, ['id', 'sessionId']);
  const sessionType = pickString(payload, ['type'])?.toUpperCase();
  const status = pickString(payload, ['status'])?.toUpperCase() ?? 'PENDING';
  const amountUsd = pickNumber(payload, ['amount', 'amountUsd', 'amountUSD']);
  const localCurrency = pickString(payload, ['currency', 'localCurrency'])?.toUpperCase();
  const cryptoCurrency =
    pickString(payload, ['cryptoCurrency', 'quote.cryptoCurrency'])?.toUpperCase();
  const cryptoNetwork =
    pickString(payload, ['cryptoNetwork', 'quote.cryptoNetwork'])?.toUpperCase();
  const userWallet =
    metadata?.walletAddress ??
    pickString(payload, ['walletAddress', 'resolvedRecipient', 'destination.walletAddress'])?.toLowerCase();

  if (
    !providerReference ||
    (sessionType !== 'ONRAMP' && sessionType !== 'OFFRAMP') ||
    !amountUsd ||
    !localCurrency ||
    !cryptoCurrency ||
    !cryptoNetwork ||
    !userWallet ||
    !metadata
  ) {
    return null;
  }

  return PaymentSessionCreatedEvent.parse({
    eventType: 'PAYMENT_SESSION_CREATED',
    paymentId: deterministicPaymentId(providerReference),
    userId: metadata.userId,
    paymentProvider: 'pouch',
    providerReference,
    sessionType,
    status,
    amountUsd,
    amountLocal: pickNumber(payload, [
      'paymentInstruction.amountLocal',
      'paymentInstruction.localAmount',
      'amountLocal',
      'quote.amountLocal',
    ]),
    localCurrency,
    cryptoCurrency,
    cryptoNetwork,
    chain: pickString(payload, ['chain'])?.toUpperCase(),
    customerEmail: pickString(payload, ['email', 'customerEmail']) ?? undefined,
    userWallet,
    walletTag: pickString(payload, ['walletTag', 'memo', 'tag']) ?? undefined,
    timestamp: asIsoTimestamp(
      pickString(payload, ['createdAt', 'updatedAt']) ?? new Date().toISOString(),
    ),
  });
}

export function normalizePouchOnrampSettled(input: unknown): OnrampSettledEvent | null {
  const payload = isRecord(input) ? input : null;
  if (!payload) return null;

  const metadata = readPouchMetadata(payload['metadata']);
  const providerReference = pickString(payload, ['id', 'sessionId']);
  const sessionType = pickString(payload, ['type'])?.toUpperCase();
  const status = pickString(payload, ['status'])?.toUpperCase() ?? '';
  const amountUsd = pickNumber(payload, ['amount', 'amountUsd', 'amountUSD']);
  const localCurrency = pickString(payload, ['currency', 'localCurrency'])?.toUpperCase();
  const cryptoCurrency =
    pickString(payload, [
      'paymentInstruction.cryptoCurrency',
      'cryptoCurrency',
      'quote.cryptoCurrency',
    ])?.toUpperCase();
  const cryptoNetwork =
    pickString(payload, [
      'paymentInstruction.cryptoNetwork',
      'cryptoNetwork',
      'quote.cryptoNetwork',
    ])?.toUpperCase();
  const userWallet =
    metadata?.walletAddress ??
    pickString(payload, ['walletAddress', 'resolvedRecipient', 'destination.walletAddress'])?.toLowerCase();
  const amountUsdt = extractWalletCreditAmount(payload, cryptoCurrency);

  if (
    !providerReference ||
    sessionType !== 'ONRAMP' ||
    !SETTLED_STATUSES.has(status) ||
    !amountUsd ||
    !localCurrency ||
    !cryptoCurrency ||
    !cryptoNetwork ||
    !userWallet ||
    !amountUsdt ||
    !metadata
  ) {
    return null;
  }

  return OnrampSettledEvent.parse({
    eventType: 'ONRAMP_SETTLED',
    paymentId: deterministicPaymentId(providerReference),
    userId: metadata.userId,
    paymentProvider: 'pouch',
    providerReference,
    amountUsd,
    amountLocal: pickNumber(payload, [
      'paymentInstruction.amountLocal',
      'paymentInstruction.localAmount',
      'amountLocal',
      'quote.amountLocal',
    ]),
    localCurrency,
    amountUsdt,
    cryptoCurrency,
    cryptoNetwork,
    chain: pickString(payload, ['chain'])?.toUpperCase(),
    userWallet,
    settlementReference: pickString(payload, [
      'paymentInstruction.reference',
      'reference',
      'txHash',
      'transactionHash',
    ]),
    timestamp: asIsoTimestamp(
      pickString(payload, ['completedAt', 'updatedAt', 'createdAt']) ?? new Date().toISOString(),
    ),
  });
}

function extractWalletCreditAmount(
  payload: Record<string, unknown>,
  cryptoCurrency: string | undefined,
): number | undefined {
  const directUsdt = pickNumber(payload, ['amountUsdt', 'quote.amountUsdt']);
  if (directUsdt && directUsdt > 0) {
    return directUsdt;
  }

  if (cryptoCurrency !== 'USDT' && cryptoCurrency !== 'USDC') {
    return undefined;
  }

  const cryptoAmount = pickNumber(payload, [
    'paymentInstruction.cryptoAmount',
    'cryptoAmount',
    'quote.cryptoAmount',
  ]);

  return cryptoAmount && cryptoAmount > 0 ? cryptoAmount : undefined;
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
