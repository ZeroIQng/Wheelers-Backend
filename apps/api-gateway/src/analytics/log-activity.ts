import { activityClient } from '@wheleers/db';

/**
 * Fire-and-forget per-user activity logging for actions that never produce a
 * Kafka event (logins, profile edits, quotes, admin moderation, WhatsApp
 * messages…). The Kafka firehose is archived separately by analytics-worker.
 *
 * Analytics must never block or fail a request — errors are logged and
 * swallowed, and callers must NOT await beyond the returned void.
 */
export function logActivity(input: {
  userId: string;
  eventType: string;
  source?: string;
  rideId?: string;
  metadata?: Record<string, unknown>;
}): void {
  void activityClient
    .record({
      userId: input.userId,
      eventType: input.eventType,
      source: input.source ?? 'api-gateway',
      rideId: input.rideId,
      metadata: input.metadata,
    })
    .catch((error) => {
      console.warn('[activity] log failed', {
        eventType: input.eventType,
        error: error instanceof Error ? error.message : String(error),
      });
    });
}
