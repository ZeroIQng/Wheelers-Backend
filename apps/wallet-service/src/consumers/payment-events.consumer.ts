import type { MessageContext } from '@wheleers/kafka-client';
import type { TransactionType } from '@prisma/client';
import { safeParseKafkaEvent, TOPICS } from '@wheleers/kafka-schemas';

import type { WalletRepository } from '../types';
import type { WalletEventsProducer } from '../producers/wallet-events.producer';

const FIAT_ONRAMP_TYPE = 'CRYPTO_DEPOSIT' as TransactionType;
const CRYPTO_DEPOSIT_TYPE = 'CRYPTO_DEPOSIT' as TransactionType;
const DRIVER_PAYOUT_TYPE = 'DRIVER_PAYOUT' as TransactionType;
const PENALTY_TYPE = 'PENALTY' as TransactionType;

export function createPaymentEventsConsumer(params: {
  walletRepository: WalletRepository;
  walletEventsProducer: WalletEventsProducer;
  serviceId?: string;
}) {
  const {
    walletRepository,
    walletEventsProducer,
    serviceId = 'wallet-service',
  } = params;

  return {
    async handle(value: unknown, _context: MessageContext): Promise<void> {
      const event = safeParseKafkaEvent(TOPICS.PAYMENT_EVENTS, value);
      if (!event) return;

      if (event.eventType === 'ONRAMP_SETTLED') {
        try {
          const wallet = await walletRepository.findByAddress(event.userWallet);
          const creditResult = await walletRepository.credit({
            walletId: wallet.id,
            amountUsdt: event.amountUsdt,
            type: FIAT_ONRAMP_TYPE,
            referenceId: event.providerReference,
            metadata: {
              paymentId: event.paymentId,
              paymentProvider: event.paymentProvider,
              amountUsd: event.amountUsd,
              localCurrency: event.localCurrency,
              amountLocal: event.amountLocal,
              cryptoCurrency: event.cryptoCurrency,
              cryptoNetwork: event.cryptoNetwork,
              settlementReference: event.settlementReference,
            },
          });

          if (!creditResult.applied) {
            return;
          }

          await walletEventsProducer.publishCredited({
            walletId: creditResult.wallet.id,
            userId: creditResult.wallet.userId,
            walletAddress: creditResult.wallet.address,
            amountUsdt: event.amountUsdt,
            newBalanceUsdt: Number(creditResult.wallet.balanceUsdt),
            creditType: 'fiat_onramp',
            referenceId: event.providerReference,
          }, { key: event.userId });
        } catch (error) {
          console.warn(`[${serviceId}] credit failed:`, getErrorMessage(error));
          throw error;
        }

        return;
      }

      if (event.eventType === 'CRYPTO_DEPOSIT_RECEIVED') {
        try {
          const wallet = await walletRepository.findByAddress(event.userWallet);
          const creditResult = await walletRepository.credit({
            walletId: wallet.id,
            amountUsdt: event.amountUsdt,
            type: CRYPTO_DEPOSIT_TYPE,
            referenceId: event.paymentId,
            metadata: { txHash: event.txHash, chainId: event.chainId },
          });

          if (!creditResult.applied) {
            return;
          }

          await walletEventsProducer.publishCredited({
            walletId: creditResult.wallet.id,
            userId: creditResult.wallet.userId,
            walletAddress: creditResult.wallet.address,
            amountUsdt: event.amountUsdt,
            newBalanceUsdt: Number(creditResult.wallet.balanceUsdt),
            creditType: 'crypto_deposit',
            referenceId: event.paymentId,
          }, { key: event.userId });
        } catch (error) {
          console.warn(`[${serviceId}] crypto credit failed:`, getErrorMessage(error));
          throw error;
        }

        return;
      }

      if (event.eventType === 'DRIVER_PAYOUT') {
        try {
          const wallet = await walletRepository.findByAddress(event.driverWallet);
          const creditResult = await walletRepository.credit({
            walletId: wallet.id,
            amountUsdt: event.netPayoutUsdt,
            type: DRIVER_PAYOUT_TYPE,
            referenceId: event.rideId,
            metadata: { platformFeeUsdt: event.platformFeeUsdt },
          });

          if (!creditResult.applied) {
            return;
          }

          await walletEventsProducer.publishCredited({
            walletId: creditResult.wallet.id,
            userId: creditResult.wallet.userId,
            walletAddress: creditResult.wallet.address,
            amountUsdt: event.netPayoutUsdt,
            newBalanceUsdt: Number(creditResult.wallet.balanceUsdt),
            creditType: 'driver_payout',
            referenceId: event.rideId,
          }, { key: event.driverId });
        } catch (error) {
          console.warn(`[${serviceId}] payout credit failed:`, getErrorMessage(error));
          throw error;
        }

        return;
      }

      if (event.eventType === 'PENALTY_APPLIED') {
        try {
          const wallet = await walletRepository.findByAddress(event.riderWallet);
          const debitResult = await walletRepository.debit({
            walletId: wallet.id,
            amountUsdt: event.penaltyUsdt,
            type: PENALTY_TYPE,
            referenceId: event.rideId,
          });

          if (!debitResult.applied) {
            return;
          }

          await walletEventsProducer.publishDebited({
            walletId: debitResult.wallet.id,
            userId: debitResult.wallet.userId,
            walletAddress: debitResult.wallet.address,
            amountUsdt: event.penaltyUsdt,
            newBalanceUsdt: Number(debitResult.wallet.balanceUsdt),
            debitType: 'penalty',
            referenceId: event.rideId,
          }, { key: event.userId });
        } catch (error) {
          console.warn(`[${serviceId}] penalty debit failed:`, getErrorMessage(error));
          throw error;
        }
      }
    },
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
