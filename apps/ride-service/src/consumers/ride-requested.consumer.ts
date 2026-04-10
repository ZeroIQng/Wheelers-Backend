import { rideClient } from '@wheleers/db';
import type { RideEnv } from '@wheleers/config';
import type { MessageContext } from '@wheleers/kafka-client';
import {
  safeParseKafkaEvent,
  TOPICS,
  type RideDriverRejectedEvent,
  type RideRequestedEvent,
} from '@wheleers/kafka-schemas';

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

      if (event.eventType === 'RIDE_REQUESTED') {
        await handleRideRequested(event);
        return;
      }

      if (event.eventType === 'RIDE_DRIVER_REJECTED') {
        await handleDriverRejected(event);
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
        returnAssignedDriverToPool(event.rideId);
        return;
      }

      if (event.eventType === 'RIDE_COMPLETED') {
        returnAssignedDriverToPool(event.rideId);
        return;
      }
    },
  };

  async function handleRideRequested(event: RideRequestedEvent): Promise<void> {
    // Persist (best-effort). A duplicate event should still be allowed to resume matching.
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

    const result = await matchDriver({
      rideEnv,
      onlineDrivers: state.onlineDrivers,
      rideRequested: event,
    });

    if (!result.ok) {
      console.log(`[ride-service] no matching drivers for ride ${event.rideId}: ${result.reason}`);
      await cancelNoDrivers(event);
      return;
    }

    const existing = state.pendingMatchesByRideId.get(event.rideId);
    if (existing?.timeout) clearTimeout(existing.timeout);

    state.pendingMatchesByRideId.set(event.rideId, {
      rideRequested: event,
      candidates: result.drivers,
      attemptedDriverIds: new Set(),
      offeredDriverId: null,
      timeout: null,
    });

    await offerNextDriver(event.rideId);
  }

  async function handleDriverRejected(event: RideDriverRejectedEvent): Promise<void> {
    const pending = state.pendingMatchesByRideId.get(event.rideId);
    if (!pending) return;

    if (pending.offeredDriverId !== event.driverId) {
      return;
    }

    if (pending.timeout) clearTimeout(pending.timeout);
    pending.timeout = null;
    pending.offeredDriverId = null;

    await offerNextDriver(event.rideId);
  }

  async function offerNextDriver(rideId: string): Promise<void> {
    const pending = state.pendingMatchesByRideId.get(rideId);
    if (!pending) return;

    const nextDriver = pending.candidates.find((driver) =>
      !pending.attemptedDriverIds.has(driver.driverId) &&
      state.onlineDrivers.has(driver.driverId)
    );

    if (!nextDriver) {
      await cancelNoDrivers(pending.rideRequested);
      return;
    }

    pending.attemptedDriverIds.add(nextDriver.driverId);
    pending.offeredDriverId = nextDriver.driverId;

    const timeoutMs = Number(rideEnv.DRIVER_ACCEPT_TIMEOUT_S) * 1000;
    const expiresAt = new Date(Date.now() + timeoutMs);

    await rideEventsProducer.rideOfferNotification({
      driver: nextDriver,
      rideRequested: pending.rideRequested,
      expiresAt,
    });

    pending.timeout = setTimeout(() => {
      void rideEventsProducer.rideDriverRejected({
        eventType: 'RIDE_DRIVER_REJECTED',
        rideId,
        riderId: pending.rideRequested.riderId,
        driverId: nextDriver.driverId,
        reason: 'timeout',
        timestamp: new Date().toISOString(),
      }).catch((err) => {
        console.warn(`[ride-service] driver timeout reject skipped:`, (err as any)?.message ?? err);
      });
    }, timeoutMs);
    pending.timeout.unref();

    console.log(`[ride-service] offered ride ${rideId} to driver ${nextDriver.driverId}`);
  }

  async function cancelNoDrivers(event: RideRequestedEvent): Promise<void> {
    clearPendingMatch(event.rideId);

    await rideEventsProducer.rideCancelled({
      eventType: 'RIDE_CANCELLED',
      rideId: event.rideId,
      riderId: event.riderId,
      riderWallet: event.riderWallet,
      cancelStage: 'before_match',
      penaltyUsdt: 0,
      reason: 'no_drivers_available',
      timestamp: new Date().toISOString(),
    });
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
