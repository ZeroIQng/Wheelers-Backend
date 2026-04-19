import { paymentClient } from '@wheleers/db';
import type { PaymentSessionSyncedEvent } from '@wheleers/kafka-schemas';
import { inferOnrampSettlement } from '../domain/pouch-session';
import type { PaymentEventsProducer } from '../producers/payment-events.producer';

export async function processPaymentSessionSync(
  event: PaymentSessionSyncedEvent,
  paymentEventsProducer: PaymentEventsProducer,
): Promise<boolean> {
  const settlement = inferOnrampSettlement(event);
  if (!settlement) {
    return false;
  }

  await paymentClient.recordSettlementReceived({
    paymentId: settlement.paymentId,
    userId: settlement.userId,
    provider: settlement.paymentProvider,
    providerReference: settlement.providerReference,
    userWallet: settlement.userWallet,
    amountLocal: settlement.amountLocal ?? settlement.amountUsd,
    localCurrency: settlement.localCurrency,
    metadata: {
      amountUsd: settlement.amountUsd,
      cryptoCurrency: settlement.cryptoCurrency,
      cryptoNetwork: settlement.cryptoNetwork,
      chain: settlement.chain,
      settlementReference: settlement.settlementReference,
      lastKnownStatus: event.status,
    },
  });

  const claimed = await paymentClient.claimSettlement(settlement.providerReference);
  if (!claimed) {
    return false;
  }

  try {
    await paymentEventsProducer.publishOnrampSettled(settlement);

    await paymentClient.markSettled({
      providerReference: settlement.providerReference,
      amountUsdt: settlement.amountUsdt,
      metadata: {
        amountUsd: settlement.amountUsd,
        cryptoCurrency: settlement.cryptoCurrency,
        cryptoNetwork: settlement.cryptoNetwork,
        chain: settlement.chain,
        settlementReference: settlement.settlementReference,
        lastKnownStatus: event.status,
      },
    });

    return true;
  } catch (error) {
    await paymentClient.releaseSettlementClaim(settlement.providerReference).catch(() => {});
    throw error;
  }
}
