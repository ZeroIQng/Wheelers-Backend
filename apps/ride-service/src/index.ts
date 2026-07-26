import { GoogleMapsRoutePlanner, loadWorkspaceEnv, validateRideEnv, validateSharedEnv } from '@wheleers/config';
import { createConsumer, createProducer, onShutdown } from '@wheleers/kafka-client';
import { TOPICS } from '@wheleers/kafka-schemas';

import { createRideEventsProducer } from './producers/ride-events.producer';
import { createGpsProcessedProducer } from './producers/gps-processed.producer';

import { createDriverEventsConsumer } from './consumers/driver-events.consumer';
import { createRideRequestedConsumer } from './consumers/ride-requested.consumer';
import { createGpsUpdateConsumer } from './consumers/gps-update.consumer';
import { createGroupRideDispatchConsumer } from './consumers/group-ride-dispatch.consumer';

import { startGpsMonitor } from './handlers/gps-monitor.handler';
import { startScheduledRideDispatcher } from './handlers/scheduled-rides.handler';
import { createTripLifecycleHandler } from './handlers/trip-lifecycle.handler';
import type { RideRequestedEvent } from '@wheleers/kafka-schemas';

export type OnlineDriver = {
  driverId: string;
  userId: string;
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

export type RideRouteStopState = {
  stopId?: string;
  stopOrder: number;
  type: 'intermediate' | 'final';
  status: 'pending' | 'completed' | 'skipped';
  lat: number;
  lng: number;
  address: string;
  completedAt?: string;
};

export type CounterOfferDriverInfo = {
  driverName: string;
  driverRating: number;
  vehiclePlate: string;
  vehicleModel: string;
  etaSeconds: number;
};

export type PendingRideMatch = {
  rideRequested: RideRequestedEvent;
  candidates: OnlineDriver[];
  attemptedDriverIds: Set<string>;
  offeredDriverId: string | null;
  timeout: NodeJS.Timeout | null;
  counterOfferDrivers: Map<string, CounterOfferDriverInfo>;
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
  routeByRideId: Map<string, RideRouteStopState[]>;
  pendingMatchesByRideId: Map<string, PendingRideMatch>;
};

const SERVICE_ID = 'ride-service';

bootstrap().catch((err) => {
  console.error(`[${SERVICE_ID}] fatal`, err);
  process.exit(1);
});

async function bootstrap(): Promise<void> {
  loadWorkspaceEnv();
  process.env['NODE_ENV'] ??= 'development';
  process.env['KAFKA_CLIENT_ID'] ??= SERVICE_ID;
  // Default local Kafka broker for host-managed development.
  process.env['KAFKA_BROKERS'] ??= 'localhost:29092';
  process.env['DATABASE_URL'] ??= 'postgresql://postgres:postgres@localhost:5432/wheelers';
  process.env['REDIS_URL'] ??= 'redis://localhost:6379';

  validateSharedEnv();
  const rideEnv = validateRideEnv();

  const producer = await createProducer({ serviceId: SERVICE_ID });
  const consumer = await createConsumer({ groupId: SERVICE_ID, concurrency: 1 });
  const routePlanner = new GoogleMapsRoutePlanner(
    rideEnv.GOOGLE_MAPS_BASE_URL,
    rideEnv.GOOGLE_MAPS_API_KEY,
  );

  const state: RideServiceState = {
    onlineDrivers: new Map(),
    assignedDriversByRideId: new Map(),
    rideParticipantsByRideId: new Map(),
    gpsByRideId: new Map(),
    routeByRideId: new Map(),
    pendingMatchesByRideId: new Map(),
  };

  const rideEventsProducer = createRideEventsProducer(producer);
  const gpsProcessedProducer = createGpsProcessedProducer(producer);

  const tripLifecycle = createTripLifecycleHandler({
    state,
    rideEventsProducer,
    routePlanner,
  });

  const driverEventsConsumer = createDriverEventsConsumer({
    state,
    onDriverOnline: async (event) => {
      // Check pending ride searches and send offers to this newly-online driver
      const radiusKm = Number(rideEnv.MATCH_RADIUS_KM);
      const driver = state.onlineDrivers.get(event.driverId);
      if (!driver) return;

      for (const [, pending] of state.pendingMatchesByRideId) {
        // Skip if this driver already has been offered or rejected this ride
        if (pending.attemptedDriverIds.has(event.driverId)) continue;
        if (pending.candidates.some((c) => c.driverId === event.driverId)) continue;

        const dist = haversineKm(
          pending.rideRequested.pickup.lat,
          pending.rideRequested.pickup.lng,
          driver.lat,
          driver.lng,
        );
        if (dist <= radiusKm) {
          // Add to candidates and send offer
          pending.candidates.push(driver);
          const expiresAt = new Date(Date.now() + 3 * 60 * 1000);
          await rideEventsProducer.broadcastRideOffer({
            drivers: [driver],
            rideRequested: pending.rideRequested,
            expiresAt,
          });
          console.log(`[ride-service] sent pending ride ${pending.rideRequested.rideId} to newly online driver ${event.driverId} (${dist.toFixed(1)}km away)`);
        }
      }
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

  const groupRideDispatchConsumer = createGroupRideDispatchConsumer({
    state,
    rideEnv,
    rideEventsProducer,
  });

  await consumer.subscribe(
    [TOPICS.DRIVER_EVENTS, TOPICS.RIDE_EVENTS, TOPICS.GPS_STREAM, TOPICS.GROUP_RIDE_EVENTS],
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
        return;
      }

      if (ctx.topic === TOPICS.GROUP_RIDE_EVENTS) {
        await groupRideDispatchConsumer.handle(value, ctx);
      }
    },
  );

  startGpsMonitor({
    state,
    rideEnv,
    rideEventsProducer,
  });


   const dispatcher = startScheduledRideDispatcher({
   rideEnv,
    rideEventsProducer,
    redisUrl: process.env.REDIS_URL,       // add REDIS_URL to validateSharedEnv if not already there
  });

  onShutdown(async () => {
    await dispatcher.shutdown();
    await consumer.disconnect();
    await producer.disconnect();
  });

  console.log(`[${SERVICE_ID}] consuming (matchRadiusKm=${rideEnv.MATCH_RADIUS_KM})`);
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (n: number) => (n * Math.PI) / 180;
  const r = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return r * c;
}
