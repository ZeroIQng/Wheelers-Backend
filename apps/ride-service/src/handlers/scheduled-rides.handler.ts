import { randomUUID } from 'node:crypto';
import { ScheduledRideStatus, scheduledRideClient } from '@wheleers/db';
import type { RideEnv } from '@wheleers/config';
import type { RideRequestedEvent } from '@wheleers/kafka-schemas';
import type { RideEventsProducer } from '../producers/ride-events.producer';

export function startScheduledRideDispatcher(params: {
  rideEnv: RideEnv;
  rideEventsProducer: RideEventsProducer;
}): void {
  const intervalMs = Number(params.rideEnv.SCHEDULED_RIDE_DISPATCH_INTERVAL_S) * 1000;
  const leadTimeMs = Number(params.rideEnv.SCHEDULED_RIDE_DISPATCH_LEAD_TIME_S) * 1000;

  const timer = setInterval(() => {
    void dispatchDueScheduledRides(params.rideEventsProducer, leadTimeMs);
  }, intervalMs);

  timer.unref();
}

async function dispatchDueScheduledRides(
  rideEventsProducer: RideEventsProducer,
  leadTimeMs: number,
): Promise<void> {
  const now = new Date();
  const dispatchBefore = new Date(now.getTime() + leadTimeMs);

  await scheduledRideClient.expireMissed(new Date(now.getTime() - 24 * 60 * 60 * 1000));

  const dueRides = await scheduledRideClient.findDueForDispatch(dispatchBefore, 10);

  for (const dueRide of dueRides) {
    const claimed = await scheduledRideClient.claimForDispatch(dueRide.id);
    if (!claimed || claimed.status !== ScheduledRideStatus.DISPATCHING) {
      continue;
    }

    const rideId = randomUUID();
    const scheduledStops = scheduledRideClient.parseStops(claimed.stops);
    const event: RideRequestedEvent = {
      eventType: 'RIDE_REQUESTED',
      rideId,
      riderId: claimed.riderId,
      riderWallet: claimed.riderWallet,
      pickup: {
        lat: claimed.pickupLat,
        lng: claimed.pickupLng,
        address: claimed.pickupAddress,
      },
      destination: {
        lat: claimed.destLat,
        lng: claimed.destLng,
        address: claimed.destAddress,
      },
      stops: scheduledStops,
      plannedDistanceKm: claimed.plannedDistanceKm ?? undefined,
      plannedDurationSeconds: claimed.plannedDurationSeconds ?? undefined,
      fareEstimateUsdt: Number(claimed.fareEstimateUsdt ?? 0),
      paymentMethod:
        claimed.paymentMethod === 'SMART_ACCOUNT' ? 'smart_account' : 'wallet_balance',
      timestamp: new Date().toISOString(),
    };

    try {
      await rideEventsProducer.rideRequested(event);
      await scheduledRideClient.markDispatched(claimed.id, rideId);
      console.log(`[ride-service] dispatched scheduled ride ${claimed.id} as live ride ${rideId}`);
    } catch (error) {
      await scheduledRideClient.releaseClaim(claimed.id);
      console.warn(
        `[ride-service] scheduled ride dispatch failed:`,
        (error as any)?.message ?? error,
      );
    }
  }
}
