import { randomUUID } from 'node:crypto';
import { ScheduledRideStatus, scheduledRideClient } from '@wheleers/db';
import type { RideEnv } from '@wheleers/config';
import type { RideRequestedEvent } from '@wheleers/kafka-schemas';
import type { RideEventsProducer } from '../producers/ride-events.producer';
import type { Queue } from 'bullmq';
import {
  createDispatcherQueue,
  createDispatcherWorker,
  SCHEDULED_RIDE_QUEUE,
  type ScheduledRideJobData,
} from '../queue/dispatcher.queue';

export type ScheduledRideDispatcher = {
  /** Enqueue a delayed dispatch job for a newly-created scheduled ride. */
  enqueue(scheduledRideId: string, scheduledFor: Date): Promise<void>;
  shutdown(): Promise<void>;
};

/**
 * Starts the BullMQ-backed scheduled ride dispatcher.
 *
 * Replaces the old setInterval polling approach.
 * Each ride gets its own delayed job; the worker fires it when the time comes.
 * A lightweight fallback poll still runs every `fallbackIntervalMs` to catch
 * any rides that were created before the queue existed (e.g. after a Redis wipe).
 */
export function startScheduledRideDispatcher(params: {
  rideEnv: RideEnv;
  rideEventsProducer: RideEventsProducer;
  redisUrl: string;
}): ScheduledRideDispatcher {
  const leadTimeMs = Number(params.rideEnv.SCHEDULED_RIDE_DISPATCH_LEAD_TIME_S) * 1_000;
  const fallbackIntervalMs =
    Number(params.rideEnv.SCHEDULED_RIDE_DISPATCH_INTERVAL_S) * 1_000 * 10; // 10× less frequent

  const { queue, connection: queueConn } = createDispatcherQueue(params.redisUrl);
  const { worker, connection: workerConn } = createDispatcherWorker(
    params.redisUrl,
    async (job) => {
      await dispatchSingleRide(
        job.data.scheduledRideId,
        params.rideEventsProducer,
      );
    },
  );

  // Fallback: catch rides that slipped through (Redis restart, old records, etc.)
  const fallbackTimer = setInterval(() => {
    void dispatchDueScheduledRides(params.rideEventsProducer, leadTimeMs).catch(
      (err) => console.warn('[ride-service:dispatcher] fallback sweep error:', err),
    );
  }, fallbackIntervalMs);
  fallbackTimer.unref();

  console.log(
    `[ride-service:dispatcher] BullMQ worker ready (queue=${SCHEDULED_RIDE_QUEUE}, fallbackEvery=${fallbackIntervalMs}ms)`,
  );

  return {
    async enqueue(scheduledRideId, scheduledFor) {
      const fireAt = scheduledFor.getTime() - leadTimeMs;
      const delayMs = Math.max(0, fireAt - Date.now());

      await queue.add(
        'dispatch',
        { scheduledRideId, scheduledFor: scheduledFor.toISOString() },
        {
          delay: delayMs,
          // Stable job ID — safe to re-enqueue on duplicate create calls
          jobId: `scheduled-ride:${scheduledRideId}`,
        },
      );

      console.log(
        `[ride-service:dispatcher] enqueued ${scheduledRideId} — fires in ${Math.round(delayMs / 1_000)}s`,
      );
    },

    async shutdown() {
      clearInterval(fallbackTimer);
      await worker.close();
      await queue.close();
      await workerConn.quit();
      await queueConn.quit();
    },
  };
}

// ─── internal helpers ────────────────────────────────────────────────────────

async function dispatchSingleRide(
  scheduledRideId: string,
  rideEventsProducer: RideEventsProducer,
): Promise<void> {
  const claimed = await scheduledRideClient.claimForDispatch(scheduledRideId);
  if (!claimed || claimed.status !== ScheduledRideStatus.DISPATCHING) {
    // Already dispatched, cancelled, or expired — nothing to do
    return;
  }

  await doDispatch(claimed, rideEventsProducer);
}

async function dispatchDueScheduledRides(
  rideEventsProducer: RideEventsProducer,
  leadTimeMs: number,
): Promise<void> {
  const dispatchBefore = new Date(Date.now() + leadTimeMs);
  await scheduledRideClient.expireMissed(
    new Date(Date.now() - 24 * 60 * 60 * 1_000),
  );

  const dueRides = await scheduledRideClient.findDueForDispatch(dispatchBefore, 10);

  for (const dueRide of dueRides) {
    const claimed = await scheduledRideClient.claimForDispatch(dueRide.id);
    if (!claimed || claimed.status !== ScheduledRideStatus.DISPATCHING) continue;
    await doDispatch(claimed, rideEventsProducer);
  }
}

async function doDispatch(
  claimed: Awaited<ReturnType<typeof scheduledRideClient.claimForDispatch>>,
  rideEventsProducer: RideEventsProducer,
): Promise<void> {
  if (!claimed) return;

  const rideId = randomUUID();
  const scheduledStops = scheduledRideClient.parseStops(claimed.stops);

  const event: RideRequestedEvent = {
    eventType: 'RIDE_REQUESTED',
    rideId,
    riderId: claimed.riderId,
    riderWallet: claimed.riderWallet,
    pickup: {
      lat: claimed.pickupLat,
      lng: claimed.pickupLng,
      address: claimed.pickupAddress,
    },
    destination: {
      lat: claimed.destLat,
      lng: claimed.destLng,
      address: claimed.destAddress,
    },
    stops: scheduledStops,
    plannedDistanceKm: claimed.plannedDistanceKm ?? undefined,
    plannedDurationSeconds: claimed.plannedDurationSeconds ?? undefined,
    fareEstimateUsdt: Number(claimed.fareEstimateUsdt ?? 0),
    paymentMethod:
      claimed.paymentMethod === 'SMART_ACCOUNT' ? 'smart_account' : 'wallet_balance',
    timestamp: new Date().toISOString(),
  };

  try {
    await rideEventsProducer.rideRequested(event);
    await scheduledRideClient.markDispatched(claimed.id, rideId);
    console.log(
      `[ride-service:dispatcher] dispatched scheduled ride ${claimed.id} → live ride ${rideId}`,
    );
  } catch (error) {
    await scheduledRideClient.releaseClaim(claimed.id);
    throw error; // BullMQ will retry per defaultJobOptions
  }
}