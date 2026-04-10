import { validateRideEnv, validateSharedEnv } from '@wheleers/config';
import { createConsumer, createProducer } from '@wheleers/kafka-client';
import { TOPICS } from '@wheleers/kafka-schemas';

import { createRideEventsProducer } from './producers/ride-events.producer';
import { createGpsProcessedProducer } from './producers/gps-processed.producer';

import { createDriverEventsConsumer } from './consumers/driver-events.consumer';
import { createRideRequestedConsumer } from './consumers/ride-requested.consumer';
import { createGpsUpdateConsumer } from './consumers/gps-update.consumer';

import { startGpsMonitor } from './handlers/gps-monitor.handler';
import { createTripLifecycleHandler } from './handlers/trip-lifecycle.handler';
import type { RideRequestedEvent } from '@wheleers/kafka-schemas';

export type OnlineDriver = {
  driverId: string;
  walletAddress: string;
  lat: number;
  lng: number;
  vehiclePlate: string;
  vehicleModel: string;
};

export type RideGpsState = {
  rideId: string;
  driverId: string;
  totalDistanceKm: number;
  lastLat: number;
  lastLng: number;
  lastUpdateAt: Date;
  lastMovementAt: Date;
  lastSnapshotAt: Date;
  lastStaleWarningAt: Date | null;
};

export type PendingRideMatch = {
  rideRequested: RideRequestedEvent;
  candidates: OnlineDriver[];
  attemptedDriverIds: Set<string>;
  offeredDriverId: string | null;
  timeout: NodeJS.Timeout | null;
};

export type RideParticipantState = {
  riderId: string;
  driverId: string;
};

export type RideServiceState = {
  onlineDrivers: Map<string, OnlineDriver>;
  assignedDriversByRideId: Map<string, OnlineDriver>;
  rideParticipantsByRideId: Map<string, RideParticipantState>;
  gpsByRideId: Map<string, RideGpsState>;
  pendingMatchesByRideId: Map<string, PendingRideMatch>;
};

const SERVICE_ID = 'ride-service';

bootstrap().catch((err) => {
  console.error(`[${SERVICE_ID}] fatal`, err);
  process.exit(1);
});

async function bootstrap(): Promise<void> {
  process.env['NODE_ENV'] ??= 'development';
  process.env['KAFKA_CLIENT_ID'] ??= SERVICE_ID;
  // If using `infra/docker-compose.yml`, Kafka host listener is `localhost:29092`.
  process.env['KAFKA_BROKERS'] ??= 'localhost:29092';
  process.env['DATABASE_URL'] ??= 'postgresql://postgres:postgres@localhost:5432/wheelers';
  process.env['REDIS_URL'] ??= 'redis://localhost:6379';

  validateSharedEnv();
  const rideEnv = validateRideEnv();

  const producer = await createProducer({ serviceId: SERVICE_ID });
  const consumer = await createConsumer({ groupId: SERVICE_ID, concurrency: 1 });

  const state: RideServiceState = {
    onlineDrivers: new Map(),
    assignedDriversByRideId: new Map(),
    rideParticipantsByRideId: new Map(),
    gpsByRideId: new Map(),
    pendingMatchesByRideId: new Map(),
  };

  const rideEventsProducer = createRideEventsProducer(producer);
  const gpsProcessedProducer = createGpsProcessedProducer(producer);

  const tripLifecycle = createTripLifecycleHandler(state);

  const driverEventsConsumer = createDriverEventsConsumer({
    state,
    onDriverOnline: async ({ driverId }) => {
      // no-op hook for now (room for redis pool etc.)
      void driverId;
    },
    onDriverOffline: async ({ driverId }) => {
      void driverId;
    },
  });

  const rideRequestedConsumer = createRideRequestedConsumer({
    state,
    rideEnv,
    rideEventsProducer,
  });

  const gpsUpdateConsumer = createGpsUpdateConsumer({
    state,
    gpsProcessedProducer,
    rideEventsProducer,
  });

  await consumer.subscribe(
    [TOPICS.DRIVER_EVENTS, TOPICS.RIDE_EVENTS, TOPICS.GPS_STREAM],
    async (value, ctx) => {
      if (ctx.topic === TOPICS.DRIVER_EVENTS) {
        await driverEventsConsumer.handle(value, ctx);
        return;
      }

      if (ctx.topic === TOPICS.RIDE_EVENTS) {
        await rideRequestedConsumer.handle(value, ctx);
        await tripLifecycle.handleRideEvent(value, ctx);
        return;
      }

      if (ctx.topic === TOPICS.GPS_STREAM) {
        await gpsUpdateConsumer.handle(value, ctx);
      }
    },
  );

  startGpsMonitor({
    state,
    rideEnv,
    rideEventsProducer,
  });

  console.log(`[${SERVICE_ID}] consuming (matchRadiusKm=${rideEnv.MATCH_RADIUS_KM})`);
}
