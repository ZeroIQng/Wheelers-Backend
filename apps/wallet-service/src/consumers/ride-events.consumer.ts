import type { MessageContext } from '@wheleers/kafka-client';
import { safeParseKafkaEvent, TOPICS } from '@wheleers/kafka-schemas';

import type { WalletRepository } from '../types';
import type { WalletEventsProducer } from '../producers/wallet-events.producer';

export function createRideEventsConsumer(params: {
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
      const event = safeParseKafkaEvent(TOPICS.RIDE_EVENTS, value);
      if (!event) return;

      if (event.eventType === 'RIDE_DRIVER_ASSIGNED') {
        try {
          const wallet = await walletRepository.findByUserId(event.riderId);
          const holdResult = await walletRepository.createRideHold({
            rideId: event.rideId,
            walletId: wallet.id,
            riderId: event.riderId,
            amountUsdt: event.lockedFareUsdt,
          });

          if (!holdResult.applied) {
            return;
          }

          await walletEventsProducer.publishLocked({
            walletId: holdResult.wallet.id,
            userId: holdResult.wallet.userId,
            walletAddress: holdResult.wallet.address,
            lockedAmountUsdt: event.lockedFareUsdt,
            rideId: event.rideId,
            reason: 'ride_fare_hold',
          }, { key: event.rideId });
        } catch (error) {
          console.warn(`[${serviceId}] lock failed:`, getErrorMessage(error));
        }

        return;
      }

      if (event.eventType === 'RIDE_ROUTE_UPDATED') {
        if (event.fareEstimateUsdt === undefined) {
          return;
        }

        try {
          const holdResult = await walletRepository.adjustRideHold({
            rideId: event.rideId,
            targetAmountUsdt: event.fareEstimateUsdt,
          });

          if (!holdResult || !holdResult.applied) {
            return;
          }

          await walletEventsProducer.publishHoldAdjusted({
            walletId: holdResult.wallet.id,
            userId: holdResult.wallet.userId,
            walletAddress: holdResult.wallet.address,
            previousLockedAmountUsdt: holdResult.previousHoldAmountUsdt,
            lockedAmountUsdt: holdResult.holdAmountUsdt,
            rideId: event.rideId,
            reason: 'ride_route_updated',
          }, { key: event.rideId });
        } catch (error) {
          console.warn(`[${serviceId}] hold adjust failed:`, getErrorMessage(error));
        }

        return;
      }

      if (event.eventType === 'RIDE_COMPLETED') {
        try {
          const holdResult = await walletRepository.completeRideHold({
            rideId: event.rideId,
            fareUsdt: event.fareUsdt,
          });

          if (!holdResult || !holdResult.applied) {
            return;
          }

          await walletEventsProducer.publishDebited({
            walletId: holdResult.wallet.id,
            userId: holdResult.wallet.userId,
            walletAddress: holdResult.wallet.address,
            amountUsdt: event.fareUsdt,
            newBalanceUsdt: Number(holdResult.wallet.balanceUsdt),
            debitType: 'ride_payment',
            referenceId: event.rideId,
          }, { key: event.rideId });
        } catch (error) {
          console.warn(`[${serviceId}] ride debit failed:`, getErrorMessage(error));
        }

        return;
      }

      if (event.eventType === 'RIDE_CANCELLED') {
        try {
          const holdResult = await walletRepository.cancelRideHold(event.rideId);
          if (!holdResult || !holdResult.applied) {
            return;
          }

          await walletEventsProducer.publishUnlocked({
            walletId: holdResult.wallet.id,
            userId: holdResult.wallet.userId,
            walletAddress: holdResult.wallet.address,
            unlockedAmountUsdt: holdResult.holdAmountUsdt,
            rideId: event.rideId,
            reason: 'ride_cancelled',
          }, { key: event.rideId });
        } catch (error) {
          console.warn(`[${serviceId}] unlock failed:`, getErrorMessage(error));
        }
      }
    },
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
