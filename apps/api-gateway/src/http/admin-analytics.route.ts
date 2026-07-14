import type { IncomingMessage, ServerResponse } from 'http';
import { analyticsClient } from '@wheleers/db';
import { verifyAdminAuth } from './admin-auth.route';
import { sendJson } from './utils';

interface AnalyticsDeps {
  adminApiKey: string;
  jwtSecret: string;
}

export async function handleAdminPlatformStatsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AnalyticsDeps,
): Promise<void> {
  const auth = await verifyAdminAuth(req, deps);
  if (!auth) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return;
  }

  const stats = await analyticsClient.platformStats();
  sendJson(res, 200, stats);
}

export async function handleAdminDriverAnalyticsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AnalyticsDeps,
): Promise<void> {
  const auth = await verifyAdminAuth(req, deps);
  if (!auth) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return;
  }

  const analytics = await analyticsClient.driverAnalytics();
  sendJson(res, 200, analytics);
}

export async function handleAdminRiderAnalyticsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AnalyticsDeps,
): Promise<void> {
  const auth = await verifyAdminAuth(req, deps);
  if (!auth) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return;
  }

  const analytics = await analyticsClient.riderAnalytics();
  sendJson(res, 200, analytics);
}

export async function handleAdminRecentRidesRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AnalyticsDeps,
): Promise<void> {
  const auth = await verifyAdminAuth(req, deps);
  if (!auth) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return;
  }

  const rides = await analyticsClient.recentRides();
  sendJson(res, 200, { rides });
}
