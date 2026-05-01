import { FEES } from '@wheleers/config';
import { CancelStage, DriverStatus, driverClient, rideClient } from '@wheleers/db';
import type { MessageContext } from '@wheleers/kafka-client';
import { safeParseKafkaEvent, TOPICS } from '@wheleers/kafka-schemas';

import type { RideServiceState } from '../index';
import type { RideEventsProducer } from '../producers/ride-events.producer';

export type TripLifecycleHandler = {
  handleRideEvent(value: unknown, ctx: MessageContext): Promise<void>;
};

export function createTripLifecycleHandler(params?: {
  state?: RideServiceState;
  rideEventsProducer?: RideEventsProducer;
}): TripLifecycleHandler {
  const state = params?.state;
  const rideEventsProducer = params?.rideEventsProducer;

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

      if (event.eventType === 'RIDE_ROUTE_UPDATE_REQUESTED') {
        try {
          const routeStops = await rideClient.syncRouteStops(event.rideId, {
            destination: event.destination,
            stops: event.stops,
          });
          await publishRouteUpdatedSnapshot({
            rideId: event.rideId,
            riderId: event.riderId,
            driverId: event.driverId,
            fareEstimateUsdt: event.fareEstimateUsdt,
            updatedBy: event.updatedBy,
            routeStops,
          });
        } catch (err) {
          console.warn(`[ride-service] route update skipped:`, (err as any)?.message ?? err);
        }
      }

      if (event.eventType === 'RIDE_STOP_CONFIRMED') {
        try {
          const result = await rideClient.completeNextStop(event.rideId);
          if (!result) {
            return;
          }

          await publishRouteUpdatedSnapshot({
            rideId: event.rideId,
            riderId: event.riderId,
            driverId: event.driverId,
            updatedBy: event.confirmedBy,
            routeStops: result.routeStops,
          });
        } catch (err) {
          console.warn(`[ride-service] stop confirmation skipped:`, (err as any)?.message ?? err);
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

  async function publishRouteUpdatedSnapshot(params: {
    rideId: string;
    riderId: string;
    driverId?: string;
    fareEstimateUsdt?: number;
    updatedBy: 'rider' | 'driver' | 'system';
    routeStops: Array<{
      id: string;
      stopOrder: number;
      type: 'INTERMEDIATE' | 'FINAL';
      status: 'PENDING' | 'COMPLETED' | 'SKIPPED';
      lat: number;
      lng: number;
      address: string;
      completedAt: Date | null;
    }>;
  }): Promise<void> {
    if (!rideEventsProducer) {
      return;
    }

    let driverId = params.driverId;
    if (!driverId) {
      try {
        const ride = await rideClient.findById(params.rideId);
        driverId = ride.driverId ?? undefined;
      } catch {
        driverId = undefined;
      }
    }

    const finalStop = params.routeStops.find((stop) => stop.type === 'FINAL');
    if (!finalStop) {
      return;
    }

    await rideEventsProducer.rideRouteUpdated({
      eventType: 'RIDE_ROUTE_UPDATED',
      rideId: params.rideId,
      riderId: params.riderId,
      driverId,
      destination: {
        lat: finalStop.lat,
        lng: finalStop.lng,
        address: finalStop.address,
      },
      stops: params.routeStops.map((stop) => ({
        stopId: stop.id,
        stopOrder: stop.stopOrder,
        type: stop.type === 'FINAL' ? 'final' : 'intermediate',
        status: stop.status.toLowerCase() as 'pending' | 'completed' | 'skipped',
        lat: stop.lat,
        lng: stop.lng,
        address: stop.address,
        ...(stop.completedAt ? { completedAt: stop.completedAt.toISOString() } : {}),
      })),
      fareEstimateUsdt: params.fareEstimateUsdt,
      updatedBy: params.updatedBy,
      timestamp: new Date().toISOString(),
    });
  }
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
