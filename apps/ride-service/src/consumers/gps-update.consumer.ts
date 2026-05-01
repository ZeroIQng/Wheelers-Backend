import { GPS } from '@wheleers/config';
import { rideClient } from '@wheleers/db';
import type { MessageContext } from '@wheleers/kafka-client';
import { safeParseKafkaEvent, TOPICS } from '@wheleers/kafka-schemas';

import type { RideGpsState, RideRouteStopState, RideServiceState } from '../index';
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
      const inconsistency = detectGpsInconsistency(existing, {
        lat: event.lat,
        lng: event.lng,
        accuracyM: event.accuracyM,
        now,
      });

      const next =
        !existing || !inconsistency
          ? upsertRideGpsState(existing, {
              rideId: event.rideId,
              driverId: event.driverId,
              lat: event.lat,
              lng: event.lng,
              now,
            })
          : existing;

      state.gpsByRideId.set(event.rideId, next);

      const distanceFromLastKm =
        existing && !inconsistency
          ? haversineKm(existing.lastLat, existing.lastLng, event.lat, event.lng)
          : 0;

      const isStale = isRideStale(next, now);
      const routeStops = await getRouteStopsForRide(event.rideId);
      const nextStop = findNextPendingStop(routeStops);

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
        isConsistent: !inconsistency,
        ...(inconsistency
          ? {
              inconsistencyReason: inconsistency.reason,
              ignoredDistanceKm: inconsistency.ignoredDistanceKm,
            }
          : {}),
        ...(nextStop
          ? {
              distanceToNextStopKm: haversineKm(event.lat, event.lng, nextStop.lat, nextStop.lng),
              nextStopAddress: nextStop.address,
              nextStopOrder: nextStop.stopOrder,
              remainingStopCount: routeStops.filter((stop) => stop.status === 'pending').length,
            }
          : {}),
        timestamp: event.timestamp,
      });

      // Persist sampled snapshots for disputes (best-effort)
      const snapshotIntervalMs = GPS.DB_SNAPSHOT_INTERVAL_SECONDS * 1000;
      if (!inconsistency && now.getTime() - next.lastSnapshotAt.getTime() >= snapshotIntervalMs) {
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
            lastKnownLat: next.lastLat,
            lastKnownLng: next.lastLng,
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
              lastKnownLat: next.lastLat,
              lastKnownLng: next.lastLng,
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

  async function getRouteStopsForRide(rideId: string): Promise<RideRouteStopState[]> {
    const existingRoute = state.routeByRideId.get(rideId);
    if (existingRoute) {
      return existingRoute;
    }

    try {
      const routeStops = await rideClient.findRouteStops(rideId);
      const mappedStops = routeStops.map<RideRouteStopState>((stop) => ({
        stopId: stop.id,
        stopOrder: stop.stopOrder,
        type: stop.type === 'FINAL' ? 'final' : 'intermediate',
        status: stop.status.toLowerCase() as RideRouteStopState['status'],
        lat: stop.lat,
        lng: stop.lng,
        address: stop.address,
        ...(stop.completedAt ? { completedAt: stop.completedAt.toISOString() } : {}),
      }));
      state.routeByRideId.set(rideId, mappedStops);
      return mappedStops;
    } catch {
      return [];
    }
  }
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

function detectGpsInconsistency(
  existing: RideGpsState | undefined,
  input: { lat: number; lng: number; accuracyM?: number; now: Date },
): { reason: 'poor_accuracy' | 'impossible_speed'; ignoredDistanceKm: number } | null {
  if (!existing) {
    return null;
  }

  const rawDistanceKm = haversineKm(existing.lastLat, existing.lastLng, input.lat, input.lng);

  if (
    typeof input.accuracyM === 'number' &&
    Number.isFinite(input.accuracyM) &&
    input.accuracyM > GPS.MAX_ACCEPTABLE_ACCURACY_METRES
  ) {
    return {
      reason: 'poor_accuracy',
      ignoredDistanceKm: rawDistanceKm,
    };
  }

  const elapsedHours = (input.now.getTime() - existing.lastUpdateAt.getTime()) / 3_600_000;
  if (elapsedHours <= 0) {
    return null;
  }

  const impliedSpeedKmh = rawDistanceKm / elapsedHours;
  if (impliedSpeedKmh > GPS.MAX_REASONABLE_SPEED_KMH) {
    return {
      reason: 'impossible_speed',
      ignoredDistanceKm: rawDistanceKm,
    };
  }

  return null;
}

function findNextPendingStop(routeStops: RideRouteStopState[]): RideRouteStopState | undefined {
  return routeStops
    .filter((stop) => stop.status === 'pending')
    .sort((a, b) => a.stopOrder - b.stopOrder)[0];
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
