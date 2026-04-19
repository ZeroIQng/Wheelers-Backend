import { randomUUID } from 'node:crypto';
import type { WheelersProducer } from '@wheleers/kafka-client';
import { TOPICS, type RideCancelledEvent, type RideCompletedEvent } from '@wheleers/kafka-schemas';
import { getCancelPenaltyDecision } from '../domain/cancel-penalty';
import { calculateDriverPayout } from '../domain/driver-payout';

export function createPaymentEventsProducer(producer: WheelersProducer) {
  return {
    async publishDriverPayout(event: RideCompletedEvent): Promise<void> {
      const payout = calculateDriverPayout(event);

      await producer.send(TOPICS.PAYMENT_EVENTS, {
        eventType: 'DRIVER_PAYOUT',
        paymentId: randomUUID(),
        userId: event.riderId,
        rideId: event.rideId,
        driverId: event.driverId,
        driverWallet: event.driverWallet,
        grossFareUsdt: payout.grossFareUsdt,
        driverCostsUsdt: payout.driverCostsUsdt,
        driverProfitUsdt: payout.driverProfitUsdt,
        platformFeeUsdt: payout.platformFeeUsdt,
        netPayoutUsdt: payout.netPayoutUsdt,
        feeApplied: payout.feeApplied,
        timestamp: new Date().toISOString(),
      } as const, { key: event.rideId });
    },

    async publishPenalty(event: RideCancelledEvent): Promise<void> {
      const penalty = getCancelPenaltyDecision(event);
      if (!penalty) {
        return;
      }

      await producer.send(TOPICS.PAYMENT_EVENTS, {
        eventType: 'PENALTY_APPLIED',
        paymentId: randomUUID(),
        userId: event.riderId,
        rideId: event.rideId,
        riderWallet: event.riderWallet,
        penaltyUsdt: penalty.penaltyUsdt,
        reason: penalty.reason,
        timestamp: new Date().toISOString(),
      } as const, { key: event.rideId });
    },
  };
}

export type PaymentEventsProducer = ReturnType<typeof createPaymentEventsProducer>;
