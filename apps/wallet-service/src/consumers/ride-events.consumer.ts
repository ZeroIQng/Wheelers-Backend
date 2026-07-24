import type { MessageContext } from '@wheleers/kafka-client';
import { safeParseKafkaEvent, TOPICS } from '@wheleers/kafka-schemas';
import { calculateRideFees } from '@wheleers/config';

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
        // Cash rides skip wallet hold — driver collects cash directly
        if (event.paymentMethod === 'CASH') {
          return;
        }

        try {
          const wallet = await walletRepository.findByUserId(event.riderId);
          if (!wallet) {
            console.warn(`[${serviceId}] no wallet found for rider ${event.riderId}`);
            return;
          }

          const fees = calculateRideFees(event.agreedFareNgn);
          const holdResult = await walletRepository.createRideHold({
            rideId: event.rideId,
            walletId: wallet.id,
            riderId: event.riderId,
            driverUserId: event.driverUserId,
            amountNgn: fees.totalNgn,
          });

          if (!holdResult.applied) {
            return;
          }

          await walletEventsProducer.publishLocked({
            walletId: holdResult.wallet.id,
            userId: holdResult.wallet.userId,
            lockedAmountNgn: event.agreedFareNgn,
            rideId: event.rideId,
            reason: 'ride_fare_hold',
          }, { key: event.rideId });
        } catch (error) {
          console.warn(`[${serviceId}] lock failed:`, getErrorMessage(error));
        }

        return;
      }

      if (event.eventType === 'RIDE_ROUTE_UPDATED') {
        if (event.fareEstimateNgn === undefined) {
          return;
        }

        try {
          const routeFees = calculateRideFees(event.fareEstimateNgn);
          const holdResult = await walletRepository.adjustRideHold({
            rideId: event.rideId,
            targetAmountNgn: routeFees.totalNgn,
          });

          if (!holdResult || !holdResult.applied) {
            return;
          }

          await walletEventsProducer.publishHoldAdjusted({
            walletId: holdResult.wallet.id,
            userId: holdResult.wallet.userId,
            previousLockedAmountNgn: holdResult.previousHoldAmountNgn,
            lockedAmountNgn: holdResult.holdAmountNgn,
            rideId: event.rideId,
            reason: 'ride_route_updated',
          }, { key: event.rideId });
        } catch (error) {
          console.warn(`[${serviceId}] hold adjust failed:`, getErrorMessage(error));
        }

        return;
      }

      if (event.eventType === 'RIDE_COMPLETED') {
        // Cash rides skip wallet settlement — driver already collected cash
        if (event.paymentMethod === 'CASH') {
          return;
        }

        try {
          const completionFees = calculateRideFees(event.fareNgn);

          const result = await walletRepository.completeRideHoldWithDriverPayout({
            rideId: event.rideId,
            fareNgn: event.fareNgn,
            driverUserId: event.driverUserId,
          });

          if (!result || !result.applied) {
            return;
          }

          // Publish rider debit event (total including tax + levy)
          await walletEventsProducer.publishDebited({
            walletId: result.riderWallet.id,
            userId: result.riderWallet.userId,
            amountNgn: completionFees.totalNgn,
            newBalanceNgn: Number(result.riderWallet.balanceNgn),
            debitType: 'ride_payment',
            referenceId: event.rideId,
          }, { key: event.rideId });

          // Publish driver credit event (fare only — no tax/levy)
          await walletEventsProducer.publishCredited({
            walletId: result.driverWallet.id,
            userId: result.driverWallet.userId,
            amountNgn: event.fareNgn,
            newBalanceNgn: Number(result.driverWallet.balanceNgn),
            creditType: 'driver_payout',
            referenceId: event.rideId,
          }, { key: event.rideId });
        } catch (error) {
          console.warn(`[${serviceId}] ride settlement failed:`, getErrorMessage(error));
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
            unlockedAmountNgn: holdResult.holdAmountNgn,
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
