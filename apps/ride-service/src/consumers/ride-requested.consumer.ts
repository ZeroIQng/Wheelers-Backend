import { rideClient } from '@wheleers/db';
import type { RideEnv } from '@wheleers/config';
import type { MessageContext } from '@wheleers/kafka-client';
import {
  safeParseKafkaEvent,
  TOPICS,
  type RideCounterOfferEvent,
  type RideDriverRejectedEvent,
  type RideOfferAcceptedEvent,
  type RideRouteUpdateRequestedEvent,
  type RideRequestedEvent,
} from '@wheleers/kafka-schemas';

import type { PendingRideMatch, RideServiceState } from '../index';
import type { RideEventsProducer } from '../producers/ride-events.producer';
import { matchDriver } from '../handlers/match-driver.handler';

const BID_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes

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

      if (event.eventType === 'RIDE_REQUESTED') {
        await handleRideRequested(event);
        return;
      }

      if (event.eventType === 'RIDE_COUNTER_OFFER') {
        handleCounterOffer(event);
        return;
      }

      if (event.eventType === 'RIDE_OFFER_ACCEPTED') {
        await handleOfferAccepted(event);
        return;
      }

      if (event.eventType === 'RIDE_DRIVER_REJECTED') {
        handleDriverRejected(event);
        return;
      }

      if (event.eventType === 'RIDE_ROUTE_UPDATE_REQUESTED') {
        handleRouteUpdateRequested(event);
        return;
      }

      if (event.eventType === 'RIDE_DRIVER_ASSIGNED') {
        clearPendingMatch(event.rideId);
        state.rideParticipantsByRideId.set(event.rideId, {
          riderId: event.riderId,
          driverId: event.driverId,
        });

        const assignedDriver = state.onlineDrivers.get(event.driverId);
        if (assignedDriver) {
          state.assignedDriversByRideId.set(event.rideId, assignedDriver);
          state.onlineDrivers.delete(event.driverId);
        }
        return;
      }

      if (event.eventType === 'RIDE_CANCELLED') {
        clearPendingMatch(event.rideId);
        state.routeByRideId.delete(event.rideId);
        returnAssignedDriverToPool(event.rideId);
        return;
      }

      if (event.eventType === 'RIDE_COMPLETED') {
        state.routeByRideId.delete(event.rideId);
        returnAssignedDriverToPool(event.rideId);
        return;
      }
    },
  };

  async function handleRideRequested(event: RideRequestedEvent): Promise<void> {
    state.routeByRideId.set(event.rideId, [
      ...event.stops.map((stop, index) => ({
        stopOrder: index,
        type: 'intermediate' as const,
        status: 'pending' as const,
        lat: stop.lat,
        lng: stop.lng,
        address: stop.address,
      })),
      {
        stopOrder: event.stops.length,
        type: 'final' as const,
        status: 'pending' as const,
        lat: event.destination.lat,
        lng: event.destination.lng,
        address: event.destination.address,
      },
    ]);

    // Persist ride (best-effort)
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
        stops: event.stops,
        fareEstimateNgn: event.fareEstimateNgn,
        paymentMethod: event.paymentMethod,
        riderOfferNgn: event.riderOfferNgn,
        status: 'MATCHING',
      });
    } catch (err) {
      console.warn(`[ride-service] ride create skipped:`, (err as any)?.message ?? err);
      try {
        await rideClient.markMatching(event.rideId);
      } catch (markErr) {
        console.warn(`[ride-service] ride matching persistence skipped:`, (markErr as any)?.message ?? markErr);
      }
    }

    // Find nearby drivers
    const result = await matchDriver({
      rideEnv,
      onlineDrivers: state.onlineDrivers,
      rideRequested: event,
    });

    if (!result.ok) {
      console.log(`[ride-service] no matching drivers for ride ${event.rideId}: ${result.reason}`);
      // Don't cancel — start the bid timeout instead
      startBidTimeout(event);
      return;
    }

    // Clear any existing pending match
    const existing = state.pendingMatchesByRideId.get(event.rideId);
    if (existing?.timeout) clearTimeout(existing.timeout);

    state.pendingMatchesByRideId.set(event.rideId, {
      rideRequested: event,
      candidates: result.drivers,
      attemptedDriverIds: new Set(),
      offeredDriverId: null,
      timeout: null,
      counterOfferDrivers: new Map(),
    });

    // Broadcast to ALL nearby drivers simultaneously
    const expiresAt = new Date(Date.now() + BID_TIMEOUT_MS);

    await rideEventsProducer.broadcastRideOffer({
      drivers: result.drivers,
      rideRequested: event,
      expiresAt,
    });

    console.log(`[ride-service] broadcasted ride ${event.rideId} to ${result.drivers.length} drivers`);

    // Start bid timeout
    startBidTimeout(event);
  }

  function handleCounterOffer(event: RideCounterOfferEvent): void {
    const pending = state.pendingMatchesByRideId.get(event.rideId);
    if (!pending) return;

    // Reset the bid timeout since we got activity
    if (pending.timeout) {
      clearTimeout(pending.timeout);
      pending.timeout = null;
    }

    // Store driver info so we can use it when the rider accepts
    pending.counterOfferDrivers.set(event.driverId, {
      driverName: event.driverName,
      driverRating: event.driverRating,
      vehiclePlate: event.vehiclePlate,
      vehicleModel: event.vehicleModel,
      etaSeconds: event.etaSeconds,
    });

    // Counter-offer is forwarded to rider via gateway Kafka consumer → WebSocket
    console.log(`[ride-service] counter-offer on ride ${event.rideId} from driver ${event.driverId}: ₦${event.counterOfferNgn}`);
  }

  async function handleOfferAccepted(event: RideOfferAcceptedEvent): Promise<void> {
    const pending = state.pendingMatchesByRideId.get(event.rideId);
    if (!pending) return;

    // Clear timeout
    if (pending.timeout) clearTimeout(pending.timeout);

    // Look up stored counter-offer driver info, fallback to in-memory pool for vehicle details
    const counterOfferInfo = pending.counterOfferDrivers.get(event.driverId);
    const poolDriver = pending.candidates.find((d) => d.driverId === event.driverId)
      ?? state.onlineDrivers.get(event.driverId);

    // Publish RIDE_DRIVER_ASSIGNED
    await rideEventsProducer.rideDriverAssigned({
      eventType: 'RIDE_DRIVER_ASSIGNED',
      rideId: event.rideId,
      riderId: event.riderId,
      driverId: event.driverId,
      driverUserId: event.driverUserId,
      driverName: counterOfferInfo?.driverName ?? 'Driver',
      driverRating: counterOfferInfo?.driverRating ?? 5.0,
      vehiclePlate: counterOfferInfo?.vehiclePlate ?? poolDriver?.vehiclePlate ?? '',
      vehicleModel: counterOfferInfo?.vehicleModel ?? poolDriver?.vehicleModel ?? '',
      etaSeconds: counterOfferInfo?.etaSeconds ?? 0,
      agreedFareNgn: event.agreedFareNgn,
      lockedFareNgn: event.agreedFareNgn,
      paymentMethod: event.paymentMethod,
      timestamp: new Date().toISOString(),
    });

    // Clean up pending state
    state.pendingMatchesByRideId.delete(event.rideId);
  }

  function handleDriverRejected(event: RideDriverRejectedEvent): void {
    const pending = state.pendingMatchesByRideId.get(event.rideId);
    if (!pending) return;

    // Remove driver from candidates
    pending.candidates = pending.candidates.filter((d) => d.driverId !== event.driverId);
    pending.attemptedDriverIds.add(event.driverId);
  }

  function handleRouteUpdateRequested(event: RideRouteUpdateRequestedEvent): void {
    const pending = state.pendingMatchesByRideId.get(event.rideId);
    if (!pending) return;

    pending.rideRequested = {
      ...pending.rideRequested,
      destination: event.destination,
      stops: event.stops,
      plannedDistanceKm: event.plannedDistanceKm ?? pending.rideRequested.plannedDistanceKm,
      plannedDurationSeconds:
        event.plannedDurationSeconds ?? pending.rideRequested.plannedDurationSeconds,
      fareEstimateNgn: event.fareEstimateNgn ?? pending.rideRequested.fareEstimateNgn,
      timestamp: event.timestamp,
    };
  }

  function startBidTimeout(event: RideRequestedEvent): void {
    const pending = state.pendingMatchesByRideId.get(event.rideId);

    const timeout = setTimeout(() => {
      void rideEventsProducer.rideBidTimeout({
        eventType: 'RIDE_BID_TIMEOUT',
        rideId: event.rideId,
        riderId: event.riderId,
        timestamp: new Date().toISOString(),
      }).catch((err) => {
        console.warn(`[ride-service] bid timeout publish failed:`, (err as any)?.message ?? err);
      });
    }, BID_TIMEOUT_MS);
    timeout.unref();

    if (pending) {
      pending.timeout = timeout;
    } else {
      // No drivers found — create a minimal pending entry for the timeout
      state.pendingMatchesByRideId.set(event.rideId, {
        rideRequested: event,
        candidates: [],
        attemptedDriverIds: new Set(),
        offeredDriverId: null,
        timeout,
        counterOfferDrivers: new Map(),
      });
    }
  }

  function clearPendingMatch(rideId: string): void {
    const pending = state.pendingMatchesByRideId.get(rideId);
    if (pending?.timeout) clearTimeout(pending.timeout);
    state.pendingMatchesByRideId.delete(rideId);
  }

  function returnAssignedDriverToPool(rideId: string): void {
    const assignedDriver = state.assignedDriversByRideId.get(rideId);
    state.rideParticipantsByRideId.delete(rideId);
    if (!assignedDriver) return;

    const gps = state.gpsByRideId.get(rideId);
    state.onlineDrivers.set(assignedDriver.driverId, {
      ...assignedDriver,
      lat: gps?.lastLat ?? assignedDriver.lat,
      lng: gps?.lastLng ?? assignedDriver.lng,
    });
    state.assignedDriversByRideId.delete(rideId);
  }
}
