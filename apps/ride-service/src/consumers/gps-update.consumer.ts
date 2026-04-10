import { GPS } from '@wheleers/config';
import { rideClient } from '@wheleers/db';
import type { MessageContext } from '@wheleers/kafka-client';
import { safeParseKafkaEvent, TOPICS } from '@wheleers/kafka-schemas';

import type { RideServiceState, RideGpsState } from '../index';
import type { GpsProcessedProducer } from '../producers/gps-processed.producer';
import type { RideEventsProducer } from '../producers/ride-events.producer';

export function createGpsUpdateConsumer(params: {
  state: RideServiceState;
  gpsProcessedProducer: GpsProcessedProducer;
  rideEventsProducer: RideEventsProducer;
}): { handle: (value: unknown, ctx: MessageContext) => Promise<void> } {
  const { state, gpsProcessedProducer, rideEventsProducer } = params;

  return {
    async handle(value, ctx) {
      if (ctx.topic !== TOPICS.GPS_STREAM) return;
      const event = safeParseKafkaEvent(TOPICS.GPS_STREAM, value);
      if (!event) return;
      if (event.eventType !== 'GPS_UPDATE') return;

      const now = new Date(event.timestamp);
      const existing = state.gpsByRideId.get(event.rideId);

      const next = upsertRideGpsState(existing, {
        rideId: event.rideId,
        driverId: event.driverId,
        lat: event.lat,
        lng: event.lng,
        now,
      });

      state.gpsByRideId.set(event.rideId, next);

      const distanceFromLastKm = existing
        ? haversineKm(existing.lastLat, existing.lastLng, event.lat, event.lng)
        : 0;

      const isStale = isRideStale(next, now);

      await gpsProcessedProducer.gpsProcessed({
        eventType: 'GPS_PROCESSED',
        rideId: event.rideId,
        driverId: event.driverId,
        lat: event.lat,
        lng: event.lng,
        speedKmh: event.speedKmh,
        headingDeg: event.headingDeg,
        distanceFromLastKm,
        totalDistanceKm: next.totalDistanceKm,
        isStale,
        timestamp: event.timestamp,
      });

      // Persist sampled snapshots for disputes (best-effort)
      const snapshotIntervalMs = GPS.DB_SNAPSHOT_INTERVAL_SECONDS * 1000;
      if (now.getTime() - next.lastSnapshotAt.getTime() >= snapshotIntervalMs) {
        try {
          await rideClient.logGpsSnapshot({
            rideId: event.rideId,
            lat: event.lat,
            lng: event.lng,
            speedKmh: event.speedKmh,
            timestamp: now,
          });
          next.lastSnapshotAt = now;
        } catch (err) {
          console.warn(`[ride-service] gps snapshot skipped:`, (err as any)?.message ?? err);
        }
      }

      // Emit compliance warning when stale and not recently warned.
      const staleWindowMs = GPS.STALE_TIME_WINDOW_MINUTES * 60 * 1000;
      const shouldWarn =
        isStale &&
        (next.lastStaleWarningAt === null || (now.getTime() - next.lastStaleWarningAt.getTime()) >= staleWindowMs);

      if (shouldWarn) {
        const participants = state.rideParticipantsByRideId.get(event.rideId);
        if (participants) {
          await rideEventsProducer.gpsStaleWarning({
            eventType: 'GPS_STALE_WARNING',
            rideId: event.rideId,
            driverId: participants.driverId,
            riderId: participants.riderId,
            lastMovementAt: next.lastMovementAt.toISOString(),
            staleMinutes: GPS.STALE_TIME_WINDOW_MINUTES,
            lastKnownLat: event.lat,
            lastKnownLng: event.lng,
            timestamp: now.toISOString(),
          });
          next.lastStaleWarningAt = now;
          return;
        }

        // Replay/restart fallback: participant state may not be warm yet.
        try {
          const ride = await rideClient.findById(event.rideId);
          if (ride.driverId) {
            await rideEventsProducer.gpsStaleWarning({
              eventType: 'GPS_STALE_WARNING',
              rideId: event.rideId,
              driverId: ride.driverId,
              riderId: ride.riderId,
              lastMovementAt: next.lastMovementAt.toISOString(),
              staleMinutes: GPS.STALE_TIME_WINDOW_MINUTES,
              lastKnownLat: event.lat,
              lastKnownLng: event.lng,
              timestamp: now.toISOString(),
            });
            next.lastStaleWarningAt = now;
          }
        } catch (err) {
          console.warn(`[ride-service] stale warning skipped:`, (err as any)?.message ?? err);
        }
      }
    },
  };
}

function upsertRideGpsState(
  existing: RideGpsState | undefined,
  input: { rideId: string; driverId: string; lat: number; lng: number; now: Date },
): RideGpsState {
  if (!existing) {
    return {
      rideId: input.rideId,
      driverId: input.driverId,
      totalDistanceKm: 0,
      lastLat: input.lat,
      lastLng: input.lng,
      lastUpdateAt: input.now,
      lastMovementAt: input.now,
      lastSnapshotAt: new Date(0),
      lastStaleWarningAt: null,
    };
  }

  const deltaKm = haversineKm(existing.lastLat, existing.lastLng, input.lat, input.lng);
  const movedMetres = deltaKm * 1000;

  return {
    ...existing,
    driverId: input.driverId,
    totalDistanceKm: existing.totalDistanceKm + deltaKm,
    lastLat: input.lat,
    lastLng: input.lng,
    lastUpdateAt: input.now,
    lastMovementAt:
      movedMetres >= GPS.STALE_MOVEMENT_THRESHOLD_METRES ? input.now : existing.lastMovementAt,
  };
}

function isRideStale(state: RideGpsState, now: Date): boolean {
  const staleWindowMs = GPS.STALE_TIME_WINDOW_MINUTES * 60 * 1000;
  return now.getTime() - state.lastMovementAt.getTime() >= staleWindowMs;
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (n: number) => (n * Math.PI) / 180;
  const r = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return r * c;
}
