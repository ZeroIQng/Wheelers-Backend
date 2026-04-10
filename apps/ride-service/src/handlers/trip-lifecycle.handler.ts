import { FEES } from '@wheleers/config';
import { CancelStage, DriverStatus, driverClient, rideClient } from '@wheleers/db';
import type { MessageContext } from '@wheleers/kafka-client';
import { safeParseKafkaEvent, TOPICS } from '@wheleers/kafka-schemas';

import type { RideServiceState } from '../index';

export type TripLifecycleHandler = {
  handleRideEvent(value: unknown, ctx: MessageContext): Promise<void>;
};

export function createTripLifecycleHandler(state?: RideServiceState): TripLifecycleHandler {
  return {
    async handleRideEvent(value, ctx) {
      if (ctx.topic !== TOPICS.RIDE_EVENTS) return;
      const event = safeParseKafkaEvent(TOPICS.RIDE_EVENTS, value);
      if (!event) return;

      if (event.eventType === 'RIDE_DRIVER_ASSIGNED') {
        state?.rideParticipantsByRideId.set(event.rideId, {
          riderId: event.riderId,
          driverId: event.driverId,
        });

        try {
          await rideClient.assignDriver(event.rideId, event.driverId, event.etaSeconds);
          await driverClient.updateStatus(event.driverId, DriverStatus.ON_RIDE);
        } catch (err) {
          console.warn(`[ride-service] ride assignment persistence skipped:`, (err as any)?.message ?? err);
        }
      }

      if (event.eventType === 'RIDE_STARTED') {
        state?.rideParticipantsByRideId.set(event.rideId, {
          riderId: event.riderId,
          driverId: event.driverId,
        });

        try {
          await rideClient.start(event.rideId, event.recordingId);
        } catch (err) {
          console.warn(`[ride-service] ride start skipped:`, (err as any)?.message ?? err);
        }
      }

      if (event.eventType === 'RIDE_COMPLETED') {
        const platformFeeUsdt = round2(event.fareUsdt * FEES.PLATFORM_FEE_PERCENT);
        const driverEarningsUsdt = round2(event.fareUsdt - platformFeeUsdt);
        state?.rideParticipantsByRideId.delete(event.rideId);
        state?.gpsByRideId.delete(event.rideId);

        try {
          await rideClient.complete(event.rideId, {
            fareFinalUsdt: event.fareUsdt,
            platformFeeUsdt,
            distanceKm: event.distanceKm,
            durationSeconds: event.durationSeconds,
            recordingCid: event.recordingCid,
            recordingHash: event.recordingHash,
          });
          await driverClient.recordCompletedRide(event.driverId, driverEarningsUsdt);
          await driverClient.updateStatus(event.driverId, DriverStatus.ONLINE);
        } catch (err) {
          console.warn(`[ride-service] ride completion persistence skipped:`, (err as any)?.message ?? err);
        }
      }

      if (event.eventType === 'RIDE_CANCELLED') {
        state?.rideParticipantsByRideId.delete(event.rideId);
        state?.gpsByRideId.delete(event.rideId);

        try {
          await rideClient.cancel(event.rideId, {
            cancelStage: stageToDb(event.cancelStage),
            cancelReason: event.reason,
            penaltyUsdt: event.penaltyUsdt,
          });
          if (event.driverId) {
            await driverClient.updateStatus(event.driverId, DriverStatus.ONLINE);
          }
        } catch (err) {
          console.warn(`[ride-service] ride cancel skipped:`, (err as any)?.message ?? err);
        }
      }
    },
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function stageToDb(stage: string): CancelStage {
  switch (stage) {
    case 'before_match':
      return 'BEFORE_MATCH';
    case 'after_match':
      return 'AFTER_MATCH';
    case 'driver_en_route':
      return 'DRIVER_EN_ROUTE';
    case 'active_trip':
      return 'ACTIVE_TRIP';
    default:
      return 'BEFORE_MATCH';
  }
}
