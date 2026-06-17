import type { MessageContext } from '@wheleers/kafka-client';
import type { TransactionType } from '@prisma/client';
import { safeParseKafkaEvent, TOPICS } from '@wheleers/kafka-schemas';

import type { WalletRepository } from '../types';
import type { WalletEventsProducer } from '../producers/wallet-events.producer';

const DEPOSIT_TYPE = 'DEPOSIT' as TransactionType;

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

      if (event.eventType === 'VIRTUAL_ACCOUNT_CREDITED') {
        try {
          const wallet = await walletRepository.findByUserId(event.userId);
          if (!wallet) {
            console.warn(`[${serviceId}] no wallet found for user ${event.userId}`);
            return;
          }

          const creditResult = await walletRepository.credit({
            walletId: wallet.id,
            amountNgn: event.amountNgn,
            type: DEPOSIT_TYPE,
            referenceId: event.providerReference,
            metadata: {
              pouchVirtualAccountId: event.pouchVirtualAccountId,
              bankName: event.bankName,
              senderAccountNumber: event.senderAccountNumber,
              senderAccountName: event.senderAccountName,
            },
          });

          if (!creditResult.applied) {
            return;
          }

          await walletEventsProducer.publishCredited({
            walletId: creditResult.wallet.id,
            userId: creditResult.wallet.userId,
            amountNgn: event.amountNgn,
            newBalanceNgn: Number(creditResult.wallet.balanceNgn),
            creditType: 'deposit',
            referenceId: event.providerReference,
          }, { key: event.userId });
        } catch (error) {
          console.warn(`[${serviceId}] deposit credit failed:`, getErrorMessage(error));
          throw error;
        }

        return;
      }

      if (event.eventType === 'PAYOUT_COMPLETED') {
        console.log(
          `[${serviceId}] PAYOUT_COMPLETED for user ${event.userId}, ` +
          `pouchPayoutId=${event.pouchPayoutId} — already settled by webhook handler`,
        );
        return;
      }

      if (event.eventType === 'PAYOUT_FAILED') {
        console.log(
          `[${serviceId}] PAYOUT_FAILED for user ${event.userId}, ` +
          `pouchPayoutId=${event.pouchPayoutId}, reason=${event.failureReason} — ` +
          `already handled by webhook handler`,
        );
        return;
      }
    },
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
