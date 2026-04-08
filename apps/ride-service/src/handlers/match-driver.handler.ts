import { driverClient } from '@wheleers/db';

import type { RideEnv } from '@wheleers/config';
import type { RideRequestedEvent } from '@wheleers/kafka-schemas';

import type { OnlineDriver } from '../index';

export type MatchDriverResult =
  | { ok: true; driver: OnlineDriver }
  | { ok: false; reason: 'no_drivers_online' };

export async function matchDriver(params: {
  rideEnv: RideEnv;
  onlineDrivers: Map<string, OnlineDriver>;
  rideRequested: RideRequestedEvent;
}): Promise<MatchDriverResult> {
  const { rideEnv, onlineDrivers, rideRequested } = params;

  if (onlineDrivers.size === 0) return { ok: false, reason: 'no_drivers_online' };

  // Prefer DB proximity search when possible (falls back if DB isn’t ready).
  try {
    const radiusKm = Number(rideEnv.MATCH_RADIUS_KM);
    const candidates = await driverClient.findNearby(
      rideRequested.pickup.lat,
      rideRequested.pickup.lng,
      radiusKm,
      Number(rideEnv.MAX_MATCH_ATTEMPTS),
    );

    for (const d of candidates) {
      const inMemory = onlineDrivers.get(d.id);
      if (!inMemory) continue;
      return { ok: true, driver: inMemory };
    }
  } catch {
    // ignore and fall back to in-memory pool
  }

  // Fallback: first online driver (FIFO)
  const first = onlineDrivers.values().next();
  if (first.done) return { ok: false, reason: 'no_drivers_online' };
  return { ok: true, driver: first.value };
}

