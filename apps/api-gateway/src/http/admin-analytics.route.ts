import type { IncomingMessage, ServerResponse } from 'http';
import { activityClient, analyticsClient } from '@wheleers/db';
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

export async function handleAdminUserActivityRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AnalyticsDeps,
  url: URL,
): Promise<void> {
  const auth = await verifyAdminAuth(req, deps);
  if (!auth) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return;
  }

  const userId = url.searchParams.get('userId');
  if (!userId) {
    sendJson(res, 400, { error: 'userId query parameter is required' });
    return;
  }

  const limitRaw = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
  const result = await activityClient.listByUser(userId, {
    limit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined,
    cursor: url.searchParams.get('cursor') ?? undefined,
    eventType: url.searchParams.get('type') ?? undefined,
  });

  sendJson(res, 200, result);
}
