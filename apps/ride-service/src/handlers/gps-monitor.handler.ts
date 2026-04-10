import { GPS } from '@wheleers/config';
import { rideClient } from '@wheleers/db';

import type { RideEnv } from '@wheleers/config';
import type { RideServiceState } from '../index';
import type { RideEventsProducer } from '../producers/ride-events.producer';

// Periodic watchdog that emits a GPS_STALE_WARNING if an in-progress ride's GPS
// has not moved in the stale window. This complements per-message stale detection.
export function startGpsMonitor(params: {
  state: RideServiceState;
  rideEnv: RideEnv;
  rideEventsProducer: RideEventsProducer;
}): void {
  const { state, rideEventsProducer } = params;

  const intervalMs = Number(GPS.STALE_CHECK_INTERVAL_SECONDS) * 1000;

  setInterval(() => {
    void runGpsMonitorTick(state, rideEventsProducer).catch((err) => {
      console.warn(`[ride-service] gps monitor tick skipped:`, (err as any)?.message ?? err);
    });
  }, intervalMs).unref();
}

async function runGpsMonitorTick(
  state: RideServiceState,
  rideEventsProducer: RideEventsProducer,
): Promise<void> {
  const now = Date.now();
  for (const s of state.gpsByRideId.values()) {
    const staleWindowMs = GPS.STALE_TIME_WINDOW_MINUTES * 60 * 1000;
    const stale = now - s.lastMovementAt.getTime() >= staleWindowMs;
    if (!stale) continue;

    const alreadyWarnedRecently =
      s.lastStaleWarningAt !== null && (now - s.lastStaleWarningAt.getTime()) < staleWindowMs;
    if (alreadyWarnedRecently) continue;

    const participants = state.rideParticipantsByRideId.get(s.rideId);
    if (participants) {
      try {
        const warningAt = new Date(now);
        await emitStaleWarning(rideEventsProducer, {
          rideId: s.rideId,
          driverId: participants.driverId,
          riderId: participants.riderId,
          lastMovementAt: s.lastMovementAt,
          lastKnownLat: s.lastLat,
          lastKnownLng: s.lastLng,
          warningAt,
        });
        s.lastStaleWarningAt = warningAt;
      } catch (err) {
        console.warn(`[ride-service] gps stale warning skipped:`, (err as any)?.message ?? err);
      }
      continue;
    }

    try {
      const ride = await rideClient.findById(s.rideId);
      if (!ride.driverId) continue;

      const warningAt = new Date(now);
      await emitStaleWarning(rideEventsProducer, {
        rideId: s.rideId,
        driverId: ride.driverId,
        riderId: ride.riderId,
        lastMovementAt: s.lastMovementAt,
        lastKnownLat: s.lastLat,
        lastKnownLng: s.lastLng,
        warningAt,
      });
      s.lastStaleWarningAt = warningAt;
    } catch (err) {
      console.warn(`[ride-service] gps stale warning skipped:`, (err as any)?.message ?? err);
    }
  }
}

async function emitStaleWarning(
  rideEventsProducer: RideEventsProducer,
  input: {
    rideId: string;
    driverId: string;
    riderId: string;
    lastMovementAt: Date;
    lastKnownLat: number;
    lastKnownLng: number;
    warningAt: Date;
  },
): Promise<void> {
  await rideEventsProducer.gpsStaleWarning({
    eventType: 'GPS_STALE_WARNING',
    rideId: input.rideId,
    driverId: input.driverId,
    riderId: input.riderId,
    lastMovementAt: input.lastMovementAt.toISOString(),
    staleMinutes: GPS.STALE_TIME_WINDOW_MINUTES,
    lastKnownLat: input.lastKnownLat,
    lastKnownLng: input.lastKnownLng,
    timestamp: input.warningAt.toISOString(),
  });
}
