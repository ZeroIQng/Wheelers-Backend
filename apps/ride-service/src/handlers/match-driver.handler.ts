import { driverClient } from '@wheleers/db';

import type { RideEnv } from '@wheleers/config';
import type { RideRequestedEvent } from '@wheleers/kafka-schemas';

import type { OnlineDriver } from '../index';

export type MatchDriverResult =
  | { ok: true; drivers: OnlineDriver[] }
  | { ok: false; reason: 'no_drivers_online' | 'no_drivers_in_radius' };

export async function matchDriver(params: {
  rideEnv: RideEnv;
  onlineDrivers: Map<string, OnlineDriver>;
  rideRequested: RideRequestedEvent;
}): Promise<MatchDriverResult> {
  const { rideEnv, onlineDrivers, rideRequested } = params;

  if (onlineDrivers.size === 0) return { ok: false, reason: 'no_drivers_online' };

  const radiusKm = Number(rideEnv.MATCH_RADIUS_KM);
  const limit = Number(rideEnv.MAX_MATCH_ATTEMPTS);

  // Prefer DB proximity search when possible (falls back if DB is not ready).
  try {
    const candidates = await driverClient.findNearby(
      rideRequested.pickup.lat,
      rideRequested.pickup.lng,
      radiusKm,
      limit,
    );

    const drivers: OnlineDriver[] = [];
    for (const d of candidates) {
      const inMemory = onlineDrivers.get(d.id);
      if (!inMemory) continue;
      drivers.push(inMemory);
    }

    if (drivers.length > 0) return { ok: true, drivers };
  } catch {
    // ignore and fall back to in-memory pool
  }

  // Fallback: nearest in-memory drivers inside the configured radius.
  const drivers = Array.from(onlineDrivers.values())
    .map((driver) => ({
      driver,
      distanceKm: haversineKm(
        rideRequested.pickup.lat,
        rideRequested.pickup.lng,
        driver.lat,
        driver.lng,
      ),
    }))
    .filter(({ distanceKm }) => distanceKm <= radiusKm)
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, limit)
    .map(({ driver }) => driver);

  if (drivers.length === 0) return { ok: false, reason: 'no_drivers_in_radius' };
  return { ok: true, drivers };
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
