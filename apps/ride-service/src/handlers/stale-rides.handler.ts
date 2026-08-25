import { rideClient } from '@wheleers/db';
import { RIDE } from '@wheleers/config';
import type { RideEventsProducer } from '../producers/ride-events.producer';

/**
 * Bid timeouts are in-memory timers, so a restart mid-bidding used to leave
 * the ride in MATCHING for good. This sweep is the restart-safe backstop: any
 * ride still unmatched well past the bid window gets the same RIDE_BID_TIMEOUT
 * event the timer would have published, and every downstream handler (DB
 * cancel, wallet-hold release, rider notification) runs as normal.
 *
 * Also drains historical backlog on first run, oldest first, in batches.
 */
export interface StaleRideSweepDeps {
  rideEventsProducer: RideEventsProducer;
  intervalMs?: number;
  /** How long past the bid window a ride may sit before it is declared dead. */
  graceMs?: number;
  batchSize?: number;
}

export interface StaleRideSweep {
  runOnce(): Promise<number>;
  stop(): void;
}

export function startStaleRideSweep(deps: StaleRideSweepDeps): StaleRideSweep {
  const intervalMs = deps.intervalMs ?? 60_000;
  const graceMs = deps.graceMs ?? 2 * 60 * 1000;
  const batchSize = deps.batchSize ?? 200;
  const maxAgeMs = RIDE.BID_TIMEOUT_SECONDS * 1000 + graceMs;
  let running = false;

  async function runOnce(): Promise<number> {
    if (running) return 0;
    running = true;
    try {
      const cutoff = new Date(Date.now() - maxAgeMs);
      const stale = await rideClient.findStaleUnmatched(cutoff, batchSize);
      let published = 0;
      for (const ride of stale) {
        try {
          await deps.rideEventsProducer.rideBidTimeout({
            eventType: 'RIDE_BID_TIMEOUT',
            rideId: ride.id,
            riderId: ride.riderId,
            timestamp: new Date().toISOString(),
          });
          published += 1;
        } catch (err) {
          console.warn('[ride-service] stale ride sweep publish failed', {
            rideId: ride.id,
            error: (err as any)?.message ?? err,
          });
        }
      }
      if (published > 0) {
        console.info('[ride-service] stale ride sweep', {
          expired: published,
          oldest: stale[0]?.createdAt.toISOString(),
          moreLikely: stale.length === batchSize,
        });
      }
      return published;
    } catch (err) {
      console.warn('[ride-service] stale ride sweep failed', { error: (err as any)?.message ?? err });
      return 0;
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => void runOnce(), intervalMs);
  timer.unref();
  // Kick off shortly after boot so a restart heals quickly.
  const initial = setTimeout(() => void runOnce(), 5_000);
  initial.unref();

  return {
    runOnce,
    stop() {
      clearInterval(timer);
      clearTimeout(initial);
    },
  };
}
