import type { IncomingMessage, ServerResponse } from 'http';
import { driverClient, rideClient, walletClient } from '@wheleers/db';
import { authenticateHttpUser, HttpAuthError } from './authenticate';
import { sendJson } from './utils';

interface DriverRouteDeps {
  jwtSecret: string;
}

/**
 * 401 only for real auth failures. Anything else is our fault, not the
 * client's — reporting it as 401 makes the app treat a server error as an
 * expired session and sign the driver out.
 */
function sendDriverRouteError(
  res: ServerResponse,
  route: string,
  error: unknown,
  fallbackMessage: string,
): void {
  if (error instanceof HttpAuthError) {
    sendJson(res, 401, { error: error.message });
    return;
  }

  console.error(`[api-gateway][driver] ${route} failed`, {
    error: error instanceof Error ? error.message : String(error),
  });
  sendJson(res, 500, { error: fallbackMessage });
}

function decimalToNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  if (
    value &&
    typeof value === 'object' &&
    'toNumber' in value &&
    typeof value.toNumber === 'function'
  ) {
    const parsed = value.toNumber();
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

function parseLimit(value: string | null): number {
  if (!value) return 20;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 20;
  return Math.min(parsed, 50);
}

// GET /drivers/me/stats
export async function handleGetDriverStatsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: DriverRouteDeps,
): Promise<void> {
  try {
    const user = await authenticateHttpUser(req, deps.jwtSecret);
    const driver = await driverClient.findByUserId(user.id);

    if (!driver) {
      sendJson(res, 404, { error: 'No driver profile found.' });
      return;
    }

    const wallet = await walletClient.findByUserId(user.id);

    sendJson(res, 200, {
      driverId: driver.id,
      userId: driver.userId,
      status: driver.status,
      kycStatus: driver.kycStatus,
      rating: driver.rating,
      totalRides: driver.totalRides,
      totalEarningsNgn: decimalToNumber(driver.totalEarningsNgn),
      vehicleMake: driver.vehicleMake,
      vehicleModel: driver.vehicleModel,
      vehiclePlate: driver.vehiclePlate,
      vehicleYear: driver.vehicleYear,
      balanceNgn: wallet ? decimalToNumber(wallet.balanceNgn) : 0,
      lockedNgn: wallet ? decimalToNumber(wallet.lockedNgn) : 0,
    });
  } catch (error) {
    sendDriverRouteError(res, 'GET /drivers/me/stats', error, 'Could not load driver stats.');
  }
}

// GET /drivers/me/earnings?period=today|week|month
export async function handleGetDriverEarningsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: DriverRouteDeps,
  url: URL,
): Promise<void> {
  try {
    const user = await authenticateHttpUser(req, deps.jwtSecret);
    const driver = await driverClient.findByUserId(user.id);

    if (!driver) {
      sendJson(res, 404, { error: 'No driver profile found.' });
      return;
    }

    const period = url.searchParams.get('period') ?? 'today';
    const now = new Date();
    let since: Date;

    if (period === 'week') {
      since = new Date(now);
      since.setDate(since.getDate() - 7);
      since.setHours(0, 0, 0, 0);
    } else if (period === 'month') {
      since = new Date(now.getFullYear(), now.getMonth(), 1);
    } else {
      since = new Date(now);
      since.setHours(0, 0, 0, 0);
    }

    const wallet = await walletClient.findByUserId(user.id);
    const earningTransactions = wallet
      ? await walletClient.findDriverPayoutsSince(wallet.id, since)
      : [];

    const totalEarningsNgn = earningTransactions.reduce(
      (sum, tx) => sum + decimalToNumber(tx.amountNgn),
      0,
    );

    sendJson(res, 200, {
      period,
      totalEarningsNgn: Math.round(totalEarningsNgn * 100) / 100,
      rideCount: earningTransactions.length,
      items: earningTransactions.map((tx) => ({
        id: tx.id,
        amountNgn: decimalToNumber(tx.amountNgn),
        referenceId: tx.referenceId,
        createdAt: tx.createdAt.toISOString(),
      })),
    });
  } catch (error) {
    sendDriverRouteError(res, 'GET /drivers/me/earnings', error, 'Could not load driver earnings.');
  }
}

// GET /drivers/me/rides/history?limit=20&cursor=
export async function handleGetDriverRideHistoryRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: DriverRouteDeps,
  url: URL,
): Promise<void> {
  try {
    const user = await authenticateHttpUser(req, deps.jwtSecret);
    const driver = await driverClient.findByUserId(user.id);

    if (!driver) {
      sendJson(res, 404, { error: 'No driver profile found.' });
      return;
    }

    const limit = parseLimit(url.searchParams.get('limit'));
    const cursor = url.searchParams.get('cursor') ?? undefined;
    const rides = await rideClient.findDriverHistory(driver.id, limit, cursor);

    sendJson(res, 200, {
      items: rides.map((ride) => ({
        id: ride.id,
        status: ride.status,
        pickupAddress: ride.pickupAddress,
        destAddress: ride.destAddress,
        fareEstimateNgn: decimalToNumber(ride.fareEstimateNgn),
        fareFinalNgn: ride.fareFinalNgn ? decimalToNumber(ride.fareFinalNgn) : null,
        distanceKm: ride.distanceKm ? decimalToNumber(ride.distanceKm) : null,
        durationSeconds: ride.durationSeconds,
        matchedAt: ride.matchedAt?.toISOString() ?? null,
        startedAt: ride.startedAt?.toISOString() ?? null,
        completedAt: ride.completedAt?.toISOString() ?? null,
        cancelledAt: ride.cancelledAt?.toISOString() ?? null,
        cancelReason: ride.cancelReason,
        createdAt: ride.createdAt.toISOString(),
      })),
      nextCursor:
        rides.length === limit ? (rides[rides.length - 1]?.id ?? null) : null,
    });
  } catch (error) {
    sendDriverRouteError(res, 'GET /drivers/me/rides/history', error, 'Could not load driver ride history.');
  }
}
