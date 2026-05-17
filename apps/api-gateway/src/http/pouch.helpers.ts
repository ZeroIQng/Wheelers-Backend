import { createHash } from 'node:crypto';
import type { PaymentIntent, PaymentSessionType } from '@prisma/client';
import type {
  PaymentSessionCreatedEvent,
  PaymentSessionSyncedEvent,
} from '@wheleers/kafka-schemas';
import { asIsoTimestamp, isRecord, pickNumber, pickString } from '../utils/object';

export interface PouchTransactionMetadata {
  userId: string;
  walletAddress: string;
  initiatedBy: 'api-gateway';
}

export function buildPouchMetadata(input: {
  userId: string;
  walletAddress: string;
}): PouchTransactionMetadata {
  return {
    userId: input.userId,
    walletAddress: input.walletAddress.toLowerCase(),
    initiatedBy: 'api-gateway',
  };
}

export function readPouchMetadata(value: unknown): PouchTransactionMetadata | null {
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

export function normalizePouchTransactionCreated(input: {
  type: PaymentSessionType;
  payload: unknown;
  metadata: PouchTransactionMetadata;
  customerEmail?: string;
  chain?: string;
  walletTag?: string;
}): PaymentSessionCreatedEvent | null {
  const payload = isRecord(input.payload) ? input.payload : null;
  if (!payload) return null;

  const providerReference = pickString(payload, ['providerRef']);
  const normalizedPayload = extractInstructionPayload(payload, input.type);
  const amountUsd = pickNumber(normalizedPayload, ['amountUsd']);
  const amountLocal = pickNumber(normalizedPayload, ['amountLocal']);
  const localCurrency = pickString(normalizedPayload, ['localCurrency'])?.toUpperCase();
  const cryptoCurrency = pickString(normalizedPayload, ['cryptoCurrency'])?.toUpperCase();
  const cryptoNetwork = pickString(normalizedPayload, ['cryptoNetwork'])?.toUpperCase();

  if (
    !providerReference ||
    !amountUsd ||
    !localCurrency ||
    !cryptoCurrency ||
    !cryptoNetwork
  ) {
    return null;
  }

  return {
    eventType: 'PAYMENT_SESSION_CREATED',
    paymentId: deterministicPaymentId(providerReference),
    userId: input.metadata.userId,
    paymentProvider: 'pouch',
    providerReference,
    sessionType: input.type,
    status: 'PENDING',
    amountUsd,
    amountLocal,
    localCurrency,
    cryptoCurrency,
    cryptoNetwork,
    chain: input.chain,
    customerEmail: input.customerEmail,
    userWallet: input.metadata.walletAddress,
    walletTag: input.walletTag,
    timestamp: asIsoTimestamp(
      pickString(normalizedPayload, ['expiresAt']) ?? new Date().toISOString(),
    ),
  };
}

export function normalizePouchTransactionStatus(input: {
  payload: unknown;
  intent: PaymentIntent;
}): PaymentSessionSyncedEvent | null {
  const payload = isRecord(input.payload) ? input.payload : null;
  if (!payload) return null;

  const details = isRecord(payload['details']) ? payload['details'] : {};
  const settlementInfo = isRecord(payload['settlementInfo']) ? payload['settlementInfo'] : {};
  const providerReference =
    pickString(payload, ['providerRef']) ?? input.intent.providerReference;
  const sessionType =
    normalizeSessionType(pickString(payload, ['type'])) ?? input.intent.sessionType;
  const status =
    pickString(payload, ['status', 'failureReason']) ?? input.intent.providerStatus;
  const amountUsd = pickNumber(payload, [
    'details.amountUsd',
    'settlementInfo.amountUsd',
    'amountUsd',
  ]) ?? Number(input.intent.amountUsd);
  const amountLocal = pickNumber(payload, [
    'details.amountLocal',
    'details.localAmount',
    'settlementInfo.amountLocal',
    'amountLocal',
  ]) ?? (input.intent.amountLocal === null ? undefined : Number(input.intent.amountLocal));
  const localCurrency =
    pickString(payload, ['details.localCurrency', 'settlementInfo.localCurrency', 'localCurrency'])
      ?.toUpperCase() ?? input.intent.localCurrency.toUpperCase();
  const cryptoCurrency =
    pickString(payload, [
      'settlementInfo.cryptoCurrency',
      'details.cryptoCurrency',
      'cryptoCurrency',
    ])?.toUpperCase() ?? input.intent.cryptoCurrency.toUpperCase();
  const cryptoNetwork =
    pickString(payload, [
      'settlementInfo.cryptoNetwork',
      'details.cryptoNetwork',
      'cryptoNetwork',
    ])?.toUpperCase() ?? input.intent.cryptoNetwork.toUpperCase();
  const cryptoAmount = pickNumber(payload, [
    'settlementInfo.cryptoAmount',
    'details.cryptoAmount',
    'cryptoAmount',
  ]) ?? (input.intent.cryptoAmount === null ? undefined : Number(input.intent.cryptoAmount));

  if (!providerReference) {
    return null;
  }

  return {
    eventType: 'PAYMENT_SESSION_SYNCED',
    paymentId: input.intent.paymentId,
    userId: input.intent.userId,
    paymentProvider: 'pouch',
    providerReference,
    sessionType,
    status,
    amountUsd,
    amountLocal,
    localCurrency,
    cryptoCurrency,
    cryptoNetwork,
    cryptoAmount,
    chain:
      pickString(payload, ['details.chain', 'settlementInfo.chain'])?.toUpperCase() ??
      input.intent.chain?.toUpperCase() ??
      undefined,
    customerEmail: input.intent.customerEmail ?? undefined,
    userWallet: input.intent.userWallet.toLowerCase(),
    walletTag:
      pickString(payload, ['details.walletTag', 'settlementInfo.walletTag']) ??
      input.intent.walletTag ??
      undefined,
    settlementReference:
      pickString(payload, [
        'transactionHash',
        'settlementInfo.transactionHash',
        'settlementInfo.reference',
        'details.reference',
      ]) ?? input.intent.settlementReference ?? undefined,
    timestamp: asIsoTimestamp(
      pickString(payload, [
        'settlementInfo.expiresAt',
        'details.updatedAt',
        'details.completedAt',
      ]) ?? new Date().toISOString(),
    ),
  };
}

export function buildPaymentIntentUpsertFromEvent(
  event: PaymentSessionCreatedEvent | PaymentSessionSyncedEvent,
  providerPayload?: Record<string, unknown>,
) {
  const lifecycleStatus = deriveLifecycleStatus(event.status);
  const timestamp = new Date(event.timestamp);

  return {
    paymentId: event.paymentId,
    userId: event.userId,
    provider: event.paymentProvider,
    providerReference: event.providerReference,
    sessionType: event.sessionType,
    lifecycleStatus,
    providerStatus: event.status,
    userWallet: event.userWallet,
    amountUsd: event.amountUsd,
    amountLocal: event.amountLocal,
    localCurrency: event.localCurrency,
    cryptoCurrency: event.cryptoCurrency,
    cryptoNetwork: event.cryptoNetwork,
    cryptoAmount: 'cryptoAmount' in event ? event.cryptoAmount : undefined,
    chain: event.chain,
    customerEmail: event.customerEmail,
    walletTag: event.walletTag,
    settlementReference: 'settlementReference' in event ? event.settlementReference : undefined,
    providerPayload,
    metadata: {
      sourceEventType: event.eventType,
    },
    lastSyncedAt: event.eventType === 'PAYMENT_SESSION_SYNCED' ? timestamp : undefined,
    settledAt: lifecycleStatus === 'SETTLED' ? timestamp : undefined,
    failedAt: lifecycleStatus === 'FAILED' ? timestamp : undefined,
    expiresAt: isTerminalExpiryStatus(lifecycleStatus) ? timestamp : undefined,
  };
}

export function deriveLifecycleStatus(status: string) {
  const normalized = status.trim().toUpperCase();

  if (!normalized) {
    return 'PENDING' as const;
  }

  if (normalized.includes('EXPIRED')) {
    return 'EXPIRED' as const;
  }

  if (normalized.includes('CANCEL')) {
    return 'CANCELLED' as const;
  }

  if (normalized.includes('FAILED') || normalized.includes('REJECTED')) {
    return 'FAILED' as const;
  }

  if (
    normalized === 'COMPLETED' ||
    normalized === 'COMPLETE' ||
    normalized === 'SUCCESS' ||
    normalized === 'SUCCEEDED' ||
    normalized === 'PAID' ||
    normalized === 'SETTLED' ||
    normalized === 'FUNDED'
  ) {
    return 'SETTLED' as const;
  }

  if (
    normalized.includes('OTP') ||
    normalized.includes('KYC') ||
    normalized.includes('ACTION') ||
    normalized.includes('VERIFY') ||
    normalized.includes('IDENTIFY') ||
    normalized.includes('REQUIRED')
  ) {
    return 'REQUIRES_USER_ACTION' as const;
  }

  if (normalized === 'PENDING' || normalized === 'CREATED') {
    return 'PENDING' as const;
  }

  return 'PROCESSING' as const;
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

function extractInstructionPayload(
  payload: Record<string, unknown>,
  type: PaymentSessionType,
): Record<string, unknown> {
  const instructionKey = type === 'ONRAMP' ? 'paymentInstruction' : 'cryptoInstruction';
  const instruction = payload[instructionKey];
  return isRecord(instruction) ? instruction : payload;
}

function normalizeSessionType(value: string | undefined): PaymentSessionType | null {
  const normalized = value?.trim().toUpperCase();
  if (normalized === 'ONRAMP' || normalized === 'OFFRAMP') {
    return normalized;
  }

  return null;
}

function isTerminalExpiryStatus(status: ReturnType<typeof deriveLifecycleStatus>): boolean {
  return status === 'EXPIRED';
}
