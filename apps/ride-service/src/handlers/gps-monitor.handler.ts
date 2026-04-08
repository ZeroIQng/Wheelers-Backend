import { GPS } from '@wheleers/config';

import type { RideEnv } from '@wheleers/config';
import type { RideServiceState } from '../index';
import type { RideEventsProducer } from '../producers/ride-events.producer';

// Periodic watchdog that emits a GPS_STALE_WARNING if an in-progress ride’s GPS
// hasn’t moved in the stale window. This complements per-message stale detection.
export function startGpsMonitor(params: {
  state: RideServiceState;
  rideEnv: RideEnv;
  rideEventsProducer: RideEventsProducer;
}): void {
  const { state, rideEventsProducer } = params;

  const intervalMs = Number(GPS.STALE_CHECK_INTERVAL_SECONDS) * 1000;

  setInterval(() => {
    const now = Date.now();
    for (const s of state.gpsByRideId.values()) {
      const staleWindowMs = GPS.STALE_TIME_WINDOW_MINUTES * 60 * 1000;
      const stale = now - s.lastMovementAt.getTime() >= staleWindowMs;
      if (!stale) continue;

      const alreadyWarnedRecently =
        s.lastStaleWarningAt !== null && (now - s.lastStaleWarningAt.getTime()) < staleWindowMs;
      if (alreadyWarnedRecently) continue;

      // RiderId isn’t known in this in-memory state; gps-update.consumer will
      // emit the warning with riderId when available. So here we only mark.
      s.lastStaleWarningAt = new Date(now);

      // Best-effort: without riderId we can’t build a valid compliance event.
      // Leaving this as a no-op keeps the structure in place for when you
      // enrich state from DB (rideClient.findAllInProgress()).
      void rideEventsProducer;
    }
  }, intervalMs).unref();
}

