import { groupRideClient } from '@wheleers/db';
import type { RedisClient } from '../redis/client';
import { getGroupRequestRider, lookupPhoneByUserId } from '../whatsapp-flows/bid-state';
import { sendGroupRideWaitNudge } from '../whatsapp-flows/whatsapp-notifier';
import type { WhatsappNotifierDeps } from '../whatsapp-flows/whatsapp-notifier';

const SWEEP_INTERVAL_MS = 60_000;
const WAIT_NUDGE_MINUTES = Number(process.env['GROUP_RIDE_WAIT_NUDGE_MINUTES'] ?? 30);

/**
 * Nobody should sit in the matching pool forever wondering. After
 * WAIT_NUDGE_MINUTES without a group, the rider is asked once: keep waiting,
 * switch to a normal ride, or cancel. The reply is handled in the WhatsApp
 * webhook (`wait` / `normal` / `cancel group`).
 */
export function startGroupRideWaitNudgeSweep(params: {
  redisClient: RedisClient;
  whatsappNotifier?: WhatsappNotifierDeps;
}): () => void {
  const { redisClient, whatsappNotifier } = params;
  let running = false;

  const sweep = async () => {
    if (running || !whatsappNotifier) return;
    running = true;
    try {
      const cutoff = new Date(Date.now() - WAIT_NUDGE_MINUTES * 60 * 1000);
      const stale = await groupRideClient.findStaleOpenMatchRequests(cutoff);

      for (const request of stale) {
        // One nudge per request — setIfNotExists is the dedup.
        const flagKey = `whatsapp:group:${request.id}:wait_nudge`;
        const isFirst = await redisClient.setIfNotExists(flagKey, '1', 2 * 60 * 60).catch(() => false);
        if (!isFirst) continue;

        const isWhatsappRider = await getGroupRequestRider(redisClient, request.userId).catch(() => null);
        if (!isWhatsappRider) continue;

        const phone = await lookupPhoneByUserId(redisClient, request.userId);
        if (!phone) continue;

        await sendGroupRideWaitNudge(whatsappNotifier, phone, WAIT_NUDGE_MINUTES).catch(() => {});
      }
    } catch (error) {
      console.warn('[group-ride-wait-nudge] sweep failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void sweep(), SWEEP_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
