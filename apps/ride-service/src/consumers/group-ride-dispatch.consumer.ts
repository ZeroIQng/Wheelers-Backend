import type { RideEnv } from '@wheleers/config';
import type { MessageContext } from '@wheleers/kafka-client';
import {
  safeParseKafkaEvent,
  TOPICS,
  type GroupRideDriverDispatchRequestedEvent,
  type RideRequestedEvent,
} from '@wheleers/kafka-schemas';

import type { RideServiceState } from '../index';
import type { RideEventsProducer } from '../producers/ride-events.producer';
import { matchDriver } from '../handlers/match-driver.handler';

export function createGroupRideDispatchConsumer(params: {
  state: RideServiceState;
  rideEnv: RideEnv;
  rideEventsProducer: RideEventsProducer;
}): { handle: (value: unknown, ctx: MessageContext) => Promise<void> } {
  const { state, rideEnv, rideEventsProducer } = params;

  return {
    async handle(value, ctx) {
      if (ctx.topic !== TOPICS.GROUP_RIDE_EVENTS) return;
      const event = safeParseKafkaEvent(TOPICS.GROUP_RIDE_EVENTS, value);
      if (!event) return;

      if (event.eventType === 'GROUP_RIDE_DRIVER_DISPATCH_REQUESTED') {
        await handleDispatchRequested(event);
      }
    },
  };

  async function handleDispatchRequested(
    event: GroupRideDriverDispatchRequestedEvent,
  ): Promise<void> {
    // Synthesise a RideRequestedEvent from the group dispatch event so we can
    // reuse the existing matchDriver() and offer pipeline.
    const syntheticRide: RideRequestedEvent = {
      eventType: 'RIDE_REQUESTED',
      rideId: event.anchorRideId,
      riderId: event.riderIds[0],
      pickup: event.firstPickup,
      destination: event.firstPickup, // destination irrelevant for driver matching — only pickup matters
      stops: [],
      fareEstimateNgn: event.fareEstimateNgn,
      paymentMethod: 'WALLET',
      riderOfferNgn: event.fareEstimateNgn,
      suggestedFareNgn: event.fareEstimateNgn,
      minOfferNgn: event.fareEstimateNgn,
      ratePerKmNgn: 300,
      plannedDistanceKm: event.totalDistanceKm,
      plannedDurationSeconds: event.totalDurationSeconds,
      route: event.route,
      timestamp: event.timestamp,
    };

    const result = await matchDriver({
      rideEnv,
      onlineDrivers: state.onlineDrivers,
      rideRequested: syntheticRide,
    });

    if (!result.ok) {
      console.log(
        `[ride-service] no drivers for group ride ${event.groupId}: ${result.reason}`,
      );
      return;
    }

    // Set up the pending match so the existing offer → reject → retry loop works.
    const existing = state.pendingMatchesByRideId.get(event.anchorRideId);
    if (existing?.timeout) clearTimeout(existing.timeout);

    state.pendingMatchesByRideId.set(event.anchorRideId, {
      rideRequested: syntheticRide,
      candidates: result.drivers,
      attemptedDriverIds: new Set(),
      offeredDriverId: null,
      timeout: null,
      counterOfferDrivers: new Map(),
    });

    // Store all group ride participant mappings so the gateway can relay events.
    for (const riderId of event.riderIds) {
      state.rideParticipantsByRideId.set(event.anchorRideId, {
        riderId,
        driverId: '',
      });
    }

    // Broadcast ride offer to ALL nearby drivers simultaneously
    const BID_TIMEOUT_MS = 3 * 60 * 1000;
    const expiresAt = new Date(Date.now() + BID_TIMEOUT_MS);

    await rideEventsProducer.broadcastRideOffer({
      drivers: result.drivers,
      rideRequested: syntheticRide,
      expiresAt,
    });

    console.log(
      `[ride-service] broadcasted group ride ${event.groupId} (anchor=${event.anchorRideId}) to ${result.drivers.length} drivers`,
    );
  }
}
