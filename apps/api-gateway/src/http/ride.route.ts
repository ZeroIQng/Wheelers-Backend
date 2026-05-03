import type { IncomingMessage, ServerResponse } from 'http';
import { rideClient } from '@wheleers/db';
import { OpenRouteServiceClient } from '@wheleers/config';
import { authenticateHttpUser } from './authenticate';
import { readJsonBody, sendJson } from './utils';
import { getNumber, getRecord, getString, isRecord } from '../utils/object';

interface RideRouteDeps {
  privyAppId: string;
  privyVerificationKey: string;
  routePlanner: OpenRouteServiceClient;
}

interface RideHistoryRouteDeps {
  privyAppId: string;
  privyVerificationKey: string;
}

type LatLngAddress = {
  lat: number;
  lng: number;
  address: string;
};

function parseWaypoint(record: Record<string, unknown>, key: string): LatLngAddress {
  const value = getRecord(record, key);
  if (!value) {
    throw new Error(`Missing required field: ${key}`);
  }

  const lat = getNumber(value, 'lat');
  const lng = getNumber(value, 'lng');
  const address = getString(value, 'address');

  if (lat === undefined || lng === undefined || !address) {
    throw new Error(`Invalid ${key} payload`);
  }

  return { lat, lng, address };
}

function parseStops(record: Record<string, unknown>, key: string): LatLngAddress[] {
  const value = record[key];
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error(`Invalid ${key} payload`);
  }

  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`Invalid ${key}[${index}] payload`);
    }

    const lat = getNumber(item, 'lat');
    const lng = getNumber(item, 'lng');
    const address = getString(item, 'address');

    if (lat === undefined || lng === undefined || !address) {
      throw new Error(`Invalid ${key}[${index}] payload`);
    }

    return { lat, lng, address };
  });
}

function parseLimit(value: string | null): number {
  if (!value) {
    return 20;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 20;
  }

  return Math.min(parsed, 50);
}

function decimalToNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  if (value && typeof value === 'object' && 'toString' in value && typeof value.toString === 'function') {
    const parsed = Number(value.toString());
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

export async function handleRideEstimateRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: RideRouteDeps,
): Promise<void> {
  try {
    await authenticateHttpUser(req, deps.privyAppId, deps.privyVerificationKey);

    const rawBody = await readJsonBody(req);
    if (!isRecord(rawBody)) {
      sendJson(res, 400, { error: 'Body must be a JSON object' });
      return;
    }

    const pickup = parseWaypoint(rawBody, 'pickup');
    const destination = parseWaypoint(rawBody, 'destination');
    const stops = parseStops(rawBody, 'stops');
    const plannedRoute = await deps.routePlanner.planRoute({
      origin: pickup,
      stops,
      destination,
    });

    sendJson(res, 200, {
      plannedDistanceKm: plannedRoute.distanceKm,
      plannedDurationSeconds: plannedRoute.durationSeconds,
      fareEstimateUsdt: plannedRoute.fareEstimateUsdt,
    });
  } catch (error) {
    sendJson(res, 400, {
      error: error instanceof Error ? error.message : 'Could not estimate ride route',
    });
  }
}

export async function handleRiderRideHistoryRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: RideHistoryRouteDeps,
  url: URL,
): Promise<void> {
  try {
    const user = await authenticateHttpUser(req, deps.privyAppId, deps.privyVerificationKey);
    const limit = parseLimit(url.searchParams.get('limit'));
    const cursor = url.searchParams.get('cursor') ?? undefined;
    const rides = await rideClient.findRiderHistory(user.id, limit, cursor);

    sendJson(res, 200, {
      items: rides.map((ride) => ({
        id: ride.id,
        status: ride.status,
        pickupAddress: ride.pickupAddress,
        destAddress: ride.destAddress,
        fareEstimateUsdt: decimalToNumber(ride.fareEstimateUsdt),
        fareFinalUsdt: decimalToNumber(ride.fareFinalUsdt),
        distanceKm: ride.distanceKm ?? null,
        durationSeconds: ride.durationSeconds ?? null,
        cancelReason: ride.cancelReason ?? null,
        cancelStage: ride.cancelStage ?? null,
        matchedAt: ride.matchedAt?.toISOString() ?? null,
        startedAt: ride.startedAt?.toISOString() ?? null,
        completedAt: ride.completedAt?.toISOString() ?? null,
        cancelledAt: ride.cancelledAt?.toISOString() ?? null,
        createdAt: ride.createdAt.toISOString(),
      })),
      nextCursor: rides.length === limit ? rides[rides.length - 1]?.id ?? null : null,
    });
  } catch (error) {
    sendJson(res, 401, {
      error: error instanceof Error ? error.message : 'Could not load ride history',
    });
  }
}
