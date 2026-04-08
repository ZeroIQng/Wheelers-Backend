import { rideClient } from '@wheleers/db';
import type { RideEnv } from '@wheleers/config';
import type { MessageContext } from '@wheleers/kafka-client';
import { safeParseKafkaEvent, TOPICS } from '@wheleers/kafka-schemas';

import type { RideServiceState } from '../index';
import type { RideEventsProducer } from '../producers/ride-events.producer';
import { matchDriver } from '../handlers/match-driver.handler';

export function createRideRequestedConsumer(params: {
  state: RideServiceState;
  rideEnv: RideEnv;
  rideEventsProducer: RideEventsProducer;
}): { handle: (value: unknown, ctx: MessageContext) => Promise<void> } {
  const { state, rideEnv, rideEventsProducer } = params;

  return {
    async handle(value, ctx) {
      if (ctx.topic !== TOPICS.RIDE_EVENTS) return;
      const event = safeParseKafkaEvent(TOPICS.RIDE_EVENTS, value);
      if (!event) return;
      if (event.eventType !== 'RIDE_REQUESTED') return;

      // Persist (best-effort)
      try {
        await rideClient.create({
          id: event.rideId,
          riderId: event.riderId,
          pickupLat: event.pickup.lat,
          pickupLng: event.pickup.lng,
          pickupAddress: event.pickup.address,
          destLat: event.destination.lat,
          destLng: event.destination.lng,
          destAddress: event.destination.address,
          fareEstimateUsdt: event.fareEstimateUsdt,
        });
      } catch (err) {
        console.warn(`[ride-service] ride create skipped:`, (err as any)?.message ?? err);
      }

      const result = await matchDriver({
        rideEnv,
        onlineDrivers: state.onlineDrivers,
        rideRequested: event,
      });

      if (!result.ok) {
        console.log(`[ride-service] no drivers online for ride ${event.rideId}`);
        return;
      }

      await rideEventsProducer.rideDriverAssigned({
        eventType: 'RIDE_DRIVER_ASSIGNED',
        rideId: event.rideId,
        riderId: event.riderId,
        driverId: result.driver.driverId,
        driverWallet: result.driver.walletAddress,
        driverName: 'Driver',
        driverRating: 5,
        vehiclePlate: result.driver.vehiclePlate,
        vehicleModel: result.driver.vehicleModel,
        etaSeconds: 120,
        lockedFareUsdt: event.fareEstimateUsdt,
        timestamp: new Date().toISOString(),
      });
    },
  };
}

