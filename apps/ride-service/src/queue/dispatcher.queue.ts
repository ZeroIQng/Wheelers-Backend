import { Queue, Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';

export const SCHEDULED_RIDE_QUEUE = 'wheleers-scheduled-rides';

export type ScheduledRideJobData = {
  scheduledRideId: string;
  scheduledFor: string; // ISO string — informational
};

/**
 * Creates the BullMQ queue used to enqueue per-ride delayed dispatch jobs.
 * Call this once at service startup; reuse the returned queue instance.
 */
export function createDispatcherQueue(redisUrl: string) {
  const connection = new IORedis(redisUrl, {
    maxRetriesPerRequest: null, // required by BullMQ
    enableReadyCheck: false,
  });

  const queue = new Queue<ScheduledRideJobData>(SCHEDULED_RIDE_QUEUE, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: { count: 200 },
      removeOnFail: { count: 500 },
    },
  });

  return { queue, connection };
}

/**
 * Starts the BullMQ worker that processes dispatch jobs.
 * The processor runs inside the ride-service process — no separate container needed.
 */
export function createDispatcherWorker(
  redisUrl: string,
  processor: (job: Job<ScheduledRideJobData>) => Promise<void>,
) {
  const connection = new IORedis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });

  const worker = new Worker<ScheduledRideJobData>(
    SCHEDULED_RIDE_QUEUE,
    processor,
    {
      connection,
      concurrency: 5,
      limiter: { max: 10, duration: 1_000 }, // max 10 dispatches/sec
    },
  );

  worker.on('failed', (job, err) => {
    console.error(
      `[ride-service:dispatcher] job ${job?.id} failed (attempt ${job?.attemptsMade}):`,
      err.message,
    );
  });

  worker.on('completed', (job) => {
    console.log(
      `[ride-service:dispatcher] job ${job.id} completed (scheduledRideId=${job.data.scheduledRideId})`,
    );
  });

  return { worker, connection };
}
