import type {
  PaymentSessionCreatedEvent,
  PaymentSessionSyncedEvent,
} from '@wheleers/kafka-schemas';

export type PaymentIntentLifecycleStatus =
  | 'PENDING'
  | 'REQUIRES_USER_ACTION'
  | 'PROCESSING'
  | 'SETTLED'
  | 'FAILED'
  | 'EXPIRED'
  | 'CANCELLED';

type PaymentSessionEvent = PaymentSessionCreatedEvent | PaymentSessionSyncedEvent;

export function deriveLifecycleStatus(status: string): PaymentIntentLifecycleStatus {
  const normalized = status.trim().toUpperCase();

  if (!normalized) {
    return 'PENDING';
  }

  if (normalized.includes('EXPIRED')) {
    return 'EXPIRED';
  }

  if (normalized.includes('CANCEL')) {
    return 'CANCELLED';
  }

  if (normalized.includes('FAILED') || normalized.includes('REJECTED')) {
    return 'FAILED';
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
    return 'SETTLED';
  }

  if (
    normalized.includes('OTP') ||
    normalized.includes('KYC') ||
    normalized.includes('ACTION') ||
    normalized.includes('VERIFY') ||
    normalized.includes('IDENTIFY') ||
    normalized.includes('REQUIRED')
  ) {
    return 'REQUIRES_USER_ACTION';
  }

  if (normalized === 'PENDING' || normalized === 'CREATED') {
    return 'PENDING';
  }

  return 'PROCESSING';
}

export function buildIntentUpsertPayload(event: PaymentSessionEvent) {
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
    lastSyncedAt: event.eventType === 'PAYMENT_SESSION_SYNCED' ? timestamp : undefined,
    settledAt: lifecycleStatus === 'SETTLED' ? timestamp : undefined,
    failedAt: lifecycleStatus === 'FAILED' ? timestamp : undefined,
    expiresAt: lifecycleStatus === 'EXPIRED' ? timestamp : undefined,
    metadata: {
      sourceEventType: event.eventType,
    },
  };
}
