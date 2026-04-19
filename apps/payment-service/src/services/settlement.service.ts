import { paymentClient } from '@wheleers/db';
import type { OnrampSettledEvent } from '@wheleers/kafka-schemas';

export async function recordOnrampSettlement(event: OnrampSettledEvent): Promise<boolean> {
  await paymentClient.recordSettlementReceived({
    paymentId: event.paymentId,
    userId: event.userId,
    provider: event.paymentProvider,
    providerReference: event.providerReference,
    userWallet: event.userWallet,
    amountLocal: event.amountLocal ?? event.amountUsd,
    localCurrency: event.localCurrency,
    metadata: {
      amountUsd: event.amountUsd,
      cryptoCurrency: event.cryptoCurrency,
      cryptoNetwork: event.cryptoNetwork,
      chain: event.chain,
      settlementReference: event.settlementReference,
    },
  });

  const claimed = await paymentClient.claimSettlement(event.providerReference);
  if (!claimed) {
    return false;
  }

  try {
    await paymentClient.markSettled({
      providerReference: event.providerReference,
      amountUsdt: event.amountUsdt,
      metadata: {
        amountUsd: event.amountUsd,
        cryptoCurrency: event.cryptoCurrency,
        cryptoNetwork: event.cryptoNetwork,
        chain: event.chain,
        settlementReference: event.settlementReference,
      },
    });

    return true;
  } catch (error) {
    await paymentClient.releaseSettlementClaim(event.providerReference).catch(() => {});
    throw error;
  }
}
