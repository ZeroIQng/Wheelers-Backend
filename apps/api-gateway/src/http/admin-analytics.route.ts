import type { IncomingMessage, ServerResponse } from 'http';
import { activityClient, analyticsClient, userClient } from '@wheleers/db';
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
  const [result, users] = await Promise.all([
    activityClient.listByUser(userId, {
      limit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined,
      cursor: url.searchParams.get('cursor') ?? undefined,
      eventType: url.searchParams.get('type') ?? undefined,
    }),
    userClient.findManyByIds([userId]).catch(() => []),
  ]);

  sendJson(res, 200, { ...result, user: users[0] ?? null });
}

export async function handleAdminActivityFeedRoute(
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

  const limitRaw = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 50;

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [recent, counts] = await Promise.all([
    activityClient.listRecent(limit),
    activityClient.countsByType(since),
  ]);

  // Resolve names so the feed reads as people, not uuids
  const userIds = [...new Set(recent.map((row) => row.userId))];
  const users = userIds.length
    ? await userClient.findManyByIds(userIds).catch(() => [])
    : [];
  const nameById = new Map(users.map((u) => [u.id, { name: u.name, phone: u.phone }]));

  sendJson(res, 200, {
    counts,
    recent: recent.map((row) => ({
      id: row.id,
      userId: row.userId,
      userName: nameById.get(row.userId)?.name ?? null,
      userPhone: nameById.get(row.userId)?.phone ?? null,
      eventType: row.eventType,
      source: row.source,
      rideId: row.rideId,
      metadata: row.metadata,
      occurredAt: row.occurredAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
    })),
  });
}
