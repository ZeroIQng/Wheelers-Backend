import type { OnrampSettledEvent, PaymentSessionSyncedEvent } from '@wheleers/kafka-schemas';

const SETTLED_STATUSES = new Set([
  'COMPLETED',
  'COMPLETE',
  'SUCCESS',
  'SUCCEEDED',
  'PAID',
  'SETTLED',
  'FUNDED',
]);

export function inferOnrampSettlement(
  event: PaymentSessionSyncedEvent,
): OnrampSettledEvent | null {
  if (event.sessionType !== 'ONRAMP') {
    return null;
  }

  if (!SETTLED_STATUSES.has(event.status.toUpperCase())) {
    return null;
  }

  const amountUsdt = inferWalletCreditAmount(event);
  if (!amountUsdt) {
    return null;
  }

  return {
    eventType: 'ONRAMP_SETTLED',
    paymentId: event.paymentId,
    userId: event.userId,
    paymentProvider: event.paymentProvider,
    providerReference: event.providerReference,
    amountUsd: event.amountUsd,
    localCurrency: event.localCurrency,
    amountLocal: event.amountLocal,
    amountUsdt,
    cryptoCurrency: event.cryptoCurrency,
    cryptoNetwork: event.cryptoNetwork,
    chain: event.chain,
    userWallet: event.userWallet,
    settlementReference: event.settlementReference,
    timestamp: event.timestamp,
  };
}

function inferWalletCreditAmount(event: PaymentSessionSyncedEvent): number | null {
  if (event.cryptoCurrency === 'USDT' || event.cryptoCurrency === 'USDC') {
    const cryptoAmount = event.cryptoAmount ?? event.amountUsd;
    if (cryptoAmount > 0) {
      return cryptoAmount;
    }
  }

  return null;
}
