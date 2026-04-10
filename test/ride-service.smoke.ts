import { Kafka, Partitioners } from 'kafkajs';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

type Seen = {
  rideOffersByDriverId: Map<string, any>;
  rideAssigned: any | null;
  gpsProcessed: any | null;
  staleWarning: any | null;
};

process.env['KAFKAJS_NO_PARTITIONER_WARNING'] ??= '1';
process.env['DATABASE_URL'] ??= 'postgresql://postgres:postgres@localhost:5432/wheelers';

// If using the repo's `infra/docker-compose.yml`, the host listener is 29092.
const brokers = (process.env['KAFKA_BROKERS'] ?? 'localhost:29092')
  .split(',')
  .map((b) => b.trim())
  .filter(Boolean);

const TOPICS = {
  DRIVER_EVENTS: 'driver.events',
  RIDE_EVENTS: 'ride.events',
  GPS_STREAM: 'gps.stream',
  GPS_PROCESSED: 'gps.processed',
  COMPLIANCE_EVENTS: 'compliance.events',
  NOTIFICATION_EVENTS: 'notification.events',
} as const;

async function main(): Promise<void> {
  const kafka = new Kafka({ clientId: `ride-service-test-${Date.now()}`, brokers });
  const producer = kafka.producer({
    allowAutoTopicCreation: true,
    createPartitioner: Partitioners.LegacyPartitioner,
  });
  const consumer = kafka.consumer({ groupId: `ride-service-test-${Date.now()}` });
  const admin = kafka.admin();
  const prisma = new PrismaClient();

  const rideId = randomUUID();
  const riderId = randomUUID();
  const driverId = randomUUID();
  const secondDriverId = randomUUID();
  const riderWallet = walletAddressFromUuid(riderId);
  const driverWallet = walletAddressFromUuid(driverId);
  const secondDriverWallet = walletAddressFromUuid(secondDriverId);

  const seen: Seen = {
    rideOffersByDriverId: new Map(),
    rideAssigned: null,
    gpsProcessed: null,
    staleWarning: null,
  };

  try {
    await admin.connect();
    await producer.connect();
    await consumer.connect();
    await prisma.$connect();
  } catch (err) {
    console.error('[test] Could not connect to Kafka/Postgres.');
    console.error('[test] Expected broker:', brokers.join(','));
    console.error('[test] Expected database:', process.env['DATABASE_URL']);
    console.error('[test] If using Docker Compose, run from `infra/`:');
    console.error('[test]   docker-compose up -d zookeeper kafka postgres');
    console.error('[test] Then wait ~10–30s for Kafka to finish leader election.');
    console.error('[test] Host listener should be: localhost:29092');
    throw err;
  }

  await seedDbFixtures(prisma, {
    riderId,
    riderWallet,
    driverId,
    driverWallet,
    secondDriverId,
    secondDriverWallet,
  });

  await ensureTopics(admin);
  await waitForHealthyCluster(admin);
  await waitForRideServiceGroup(admin);

  await consumer.subscribe({ topic: TOPICS.RIDE_EVENTS, fromBeginning: false });
  await consumer.subscribe({ topic: TOPICS.GPS_PROCESSED, fromBeginning: false });
  await consumer.subscribe({ topic: TOPICS.COMPLIANCE_EVENTS, fromBeginning: false });
  await consumer.subscribe({ topic: TOPICS.NOTIFICATION_EVENTS, fromBeginning: false });

  await consumer.run({
    eachMessage: async ({ topic, message }) => {
      const raw = message.value ? message.value.toString('utf8') : '';
      if (!raw) return;
      const parsed = safeJsonParse(raw);
      if (!parsed || typeof parsed !== 'object') return;

      if (
        topic === TOPICS.RIDE_EVENTS &&
        (parsed as any).eventType === 'RIDE_DRIVER_ASSIGNED' &&
        (parsed as any).rideId === rideId
      ) {
        seen.rideAssigned = parsed;
      }

      if (
        topic === TOPICS.GPS_PROCESSED &&
        (parsed as any).eventType === 'GPS_PROCESSED' &&
        (parsed as any).rideId === rideId
      ) {
        seen.gpsProcessed = parsed;
      }

      if (
        topic === TOPICS.COMPLIANCE_EVENTS &&
        (parsed as any).eventType === 'GPS_STALE_WARNING' &&
        (parsed as any).rideId === rideId
      ) {
        seen.staleWarning = parsed;
      }

      if (
        topic === TOPICS.NOTIFICATION_EVENTS &&
        isRideOfferNotification(parsed, rideId) &&
        typeof (parsed as any).userId === 'string'
      ) {
        seen.rideOffersByDriverId.set((parsed as any).userId, parsed);
      }
    },
  });

  const nowIso = () => new Date().toISOString();

  console.log(`[test] brokers=${brokers.join(',')}`);
  console.log(`[test] rideId=${rideId}`);
  console.log(`[test] driverId=${driverId}`);
  console.log(`[test] secondDriverId=${secondDriverId}`);
  console.log(`[test] riderId=${riderId}`);

  // 1) Put two drivers online so the rejection path can retry.
  await producer.send({
    topic: TOPICS.DRIVER_EVENTS,
    messages: [
      {
        key: driverId,
        value: JSON.stringify({
          eventType: 'DRIVER_ONLINE',
          driverId,
          walletAddress: driverWallet,
          lat: 6.5244,
          lng: 3.3792,
          vehiclePlate: 'TEST-123',
          vehicleModel: 'Test Model',
          timestamp: nowIso(),
        }),
      },
      {
        key: secondDriverId,
        value: JSON.stringify({
          eventType: 'DRIVER_ONLINE',
          driverId: secondDriverId,
          walletAddress: secondDriverWallet,
          lat: 6.5245,
          lng: 3.3793,
          vehiclePlate: 'TEST-456',
          vehicleModel: 'Retry Model',
          timestamp: nowIso(),
        }),
      },
    ],
  });
  await sleep(500);

  // 2) Request a ride
  await producer.send({
    topic: TOPICS.RIDE_EVENTS,
    messages: [
      {
        key: rideId,
        value: JSON.stringify({
          eventType: 'RIDE_REQUESTED',
          rideId,
          riderId,
          riderWallet,
          pickup: { lat: 6.5244, lng: 3.3792, address: 'Pickup' },
          destination: { lat: 6.535, lng: 3.4, address: 'Destination' },
          fareEstimateUsdt: 2.5,
          paymentMethod: 'wallet_balance',
          timestamp: nowIso(),
        }),
      },
    ],
  });

  await waitFor(() => seen.rideOffersByDriverId.has(driverId), 15_000, 'first ride offer');
  console.log('[test] got first ride offer');

  // 3) Reject the nearest driver and expect ride-service to offer the next one.
  await producer.send({
    topic: TOPICS.RIDE_EVENTS,
    messages: [
      {
        key: rideId,
        value: JSON.stringify({
          eventType: 'RIDE_DRIVER_REJECTED',
          rideId,
          riderId,
          driverId,
          reason: 'manual_reject',
          timestamp: nowIso(),
        }),
      },
    ],
  });

  await waitFor(() => seen.rideOffersByDriverId.has(secondDriverId), 15_000, 'second ride offer');
  console.log('[test] got retry ride offer');

  // 4) Simulate the driver accept event emitted by api-gateway.
  await producer.send({
    topic: TOPICS.RIDE_EVENTS,
    messages: [
      {
        key: rideId,
        value: JSON.stringify({
          eventType: 'RIDE_DRIVER_ASSIGNED',
          rideId,
          riderId,
          driverId: secondDriverId,
          driverWallet: secondDriverWallet,
          driverName: 'Retry Driver',
          driverRating: 5,
          vehiclePlate: 'TEST-456',
          vehicleModel: 'Retry Model',
          etaSeconds: 120,
          lockedFareUsdt: 2.5,
          timestamp: nowIso(),
        }),
      },
    ],
  });

  await waitFor(() => !!seen.rideAssigned, 15_000, 'RIDE_DRIVER_ASSIGNED');
  console.log('[test] got RIDE_DRIVER_ASSIGNED');
  await waitForDb(
    async () => {
      const ride = await prisma.ride.findUnique({ where: { id: rideId } });
      const driver = await prisma.driver.findUnique({ where: { id: secondDriverId } });
      return ride?.status === 'DRIVER_ASSIGNED' && ride.driverId === secondDriverId && driver?.status === 'ON_RIDE';
    },
    15_000,
    'DB ride assignment',
  );
  console.log('[test] DB ride assignment persisted');

  // 5) Send one GPS ping and expect gps.processed
  await producer.send({
    topic: TOPICS.GPS_STREAM,
    messages: [
      {
        key: secondDriverId,
        value: JSON.stringify({
          eventType: 'GPS_UPDATE',
          rideId,
          driverId: secondDriverId,
          lat: 6.52441,
          lng: 3.37921,
          speedKmh: 10,
          headingDeg: 90,
          timestamp: nowIso(),
        }),
      },
    ],
  });

  await waitFor(() => !!seen.gpsProcessed, 15_000, 'GPS_PROCESSED');
  console.log('[test] got GPS_PROCESSED');
  await waitForDb(
    async () => {
      const count = await prisma.gpsLog.count({ where: { rideId } });
      return count > 0;
    },
    15_000,
    'DB GPS snapshot',
  );
  console.log('[test] DB GPS snapshot persisted');

  // 6) Complete the ride and verify durable lifecycle state.
  await producer.send({
    topic: TOPICS.RIDE_EVENTS,
    messages: [
      {
        key: rideId,
        value: JSON.stringify({
          eventType: 'RIDE_COMPLETED',
          rideId,
          riderId,
          driverId: secondDriverId,
          riderWallet,
          driverWallet: secondDriverWallet,
          fareUsdt: 2.5,
          distanceKm: 1.2,
          durationSeconds: 600,
          endedBy: 'both_confirmed',
          completedAt: nowIso(),
          timestamp: nowIso(),
        }),
      },
    ],
  });

  await waitForDb(
    async () => {
      const ride = await prisma.ride.findUnique({ where: { id: rideId } });
      const driver = await prisma.driver.findUnique({ where: { id: secondDriverId } });
      return ride?.status === 'COMPLETED' && ride.fareFinalUsdt?.toNumber() === 2.5 && driver?.status === 'ONLINE';
    },
    15_000,
    'DB ride completion',
  );
  console.log('[test] DB ride completion persisted');

  console.log('[test] PASS');
  await cleanupDbFixtures(prisma, {
    rideId,
    riderId,
    driverId,
    secondDriverId,
  });
  await prisma.$disconnect();
  await producer.disconnect();
  await consumer.disconnect();
  await admin.disconnect();
  process.exit(0);
}

function isRideOfferNotification(value: unknown, rideId: string): boolean {
  if (!value || typeof value !== 'object') return false;

  const event = value as any;
  if (event.eventType === 'IN_APP_SEND') {
    return event.category === 'ride' && event.referenceId === rideId;
  }

  if (event.eventType === 'PUSH_SEND') {
    return event.data?.type === 'ride:request' && event.data?.rideId === rideId;
  }

  return false;
}

function safeJsonParse(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error(`[test] timeout waiting for ${label} (${timeoutMs}ms)`));
      setTimeout(tick, 100);
    };
    tick();
  });
}

function waitForDb(predicate: () => Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      void predicate()
        .then((ok) => {
          if (ok) return resolve();
          if (Date.now() - started > timeoutMs) {
            return reject(new Error(`[test] timeout waiting for ${label} (${timeoutMs}ms)`));
          }
          setTimeout(tick, 100);
        })
        .catch((err) => reject(err));
    };
    tick();
  });
}

function walletAddressFromUuid(id: string): string {
  return `0x${id.replace(/-/g, '').padEnd(40, '0').slice(0, 40)}`;
}

process.on('unhandledRejection', (err) => {
  console.error('[test] unhandledRejection', err);
  process.exit(1);
});

void main().catch((err) => {
  console.error('[test] FAIL', err);
  process.exit(1);
});

async function ensureTopics(admin: ReturnType<Kafka['admin']>): Promise<void> {
  // Mirrors README partitioning.
  const topics = [
    { topic: TOPICS.DRIVER_EVENTS, numPartitions: 4, replicationFactor: 1 },
    { topic: TOPICS.RIDE_EVENTS, numPartitions: 4, replicationFactor: 1 },
    { topic: TOPICS.GPS_STREAM, numPartitions: 8, replicationFactor: 1 },
    { topic: TOPICS.GPS_PROCESSED, numPartitions: 8, replicationFactor: 1 },
    { topic: TOPICS.COMPLIANCE_EVENTS, numPartitions: 2, replicationFactor: 1 },
    { topic: TOPICS.NOTIFICATION_EVENTS, numPartitions: 2, replicationFactor: 1 },
  ];

  try {
    await admin.createTopics({
      waitForLeaders: true,
      topics,
    });
  } catch (err) {
    // If topic creation is disabled or topics already exist, keep going.
    console.warn('[test] ensureTopics warning:', (err as any)?.message ?? err);
  }
}

async function waitForHealthyCluster(admin: ReturnType<Kafka['admin']>): Promise<void> {
  // Wait until each partition has a leader (avoids "leader election" / "coordinator not available" races).
  const timeoutMs = 30_000;
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    try {
      const meta = await admin.fetchTopicMetadata({ topics: Object.values(TOPICS) as unknown as string[] });
      const hasLeaderElection = meta.topics.some((t) =>
        t.partitions.some((p) => p.leader === -1 || p.leader === undefined || p.leader === null),
      );
      if (!hasLeaderElection) return;
    } catch {
      // broker might still be starting
    }
    await sleep(500);
  }

  throw new Error('[test] Kafka cluster not ready (leaders still electing after 30s)');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function seedDbFixtures(
  prisma: PrismaClient,
  fixtures: {
    riderId: string;
    riderWallet: string;
    driverId: string;
    driverWallet: string;
    secondDriverId: string;
    secondDriverWallet: string;
  },
): Promise<void> {
  await cleanupDbFixtures(prisma, {
    rideId: '',
    riderId: fixtures.riderId,
    driverId: fixtures.driverId,
    secondDriverId: fixtures.secondDriverId,
  });

  await prisma.user.create({
    data: {
      id: fixtures.riderId,
      privyDid: `test-rider-${fixtures.riderId}`,
      walletAddress: fixtures.riderWallet,
      role: 'RIDER',
      name: 'Smoke Rider',
    },
  });

  await prisma.user.create({
    data: {
      id: `user-${fixtures.driverId}`,
      privyDid: `test-driver-${fixtures.driverId}`,
      walletAddress: fixtures.driverWallet,
      role: 'DRIVER',
      name: 'Smoke Driver',
      driver: {
        create: {
          id: fixtures.driverId,
          status: 'ONLINE',
          kycStatus: 'APPROVED',
          lat: 6.5244,
          lng: 3.3792,
          vehiclePlate: 'TEST-123',
          vehicleModel: 'Test Model',
        },
      },
    },
  });

  await prisma.user.create({
    data: {
      id: `user-${fixtures.secondDriverId}`,
      privyDid: `test-driver-${fixtures.secondDriverId}`,
      walletAddress: fixtures.secondDriverWallet,
      role: 'DRIVER',
      name: 'Retry Driver',
      driver: {
        create: {
          id: fixtures.secondDriverId,
          status: 'ONLINE',
          kycStatus: 'APPROVED',
          lat: 6.5245,
          lng: 3.3793,
          vehiclePlate: 'TEST-456',
          vehicleModel: 'Retry Model',
        },
      },
    },
  });
}

async function cleanupDbFixtures(
  prisma: PrismaClient,
  fixtures: {
    rideId: string;
    riderId: string;
    driverId: string;
    secondDriverId: string;
  },
): Promise<void> {
  if (fixtures.rideId) {
    await prisma.gpsLog.deleteMany({ where: { rideId: fixtures.rideId } });
    await prisma.ride.deleteMany({ where: { id: fixtures.rideId } });
  }

  await prisma.driver.deleteMany({
    where: { id: { in: [fixtures.driverId, fixtures.secondDriverId] } },
  });
  await prisma.user.deleteMany({
    where: {
      id: {
        in: [
          fixtures.riderId,
          `user-${fixtures.driverId}`,
          `user-${fixtures.secondDriverId}`,
        ],
      },
    },
  });
}

async function waitForRideServiceGroup(admin: ReturnType<Kafka['admin']>): Promise<void> {
  const timeoutMs = 20_000;
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    try {
      const { groups } = await admin.listGroups();
      const rideGroup = groups.find((g) => g.groupId === 'ride-service');
      if (rideGroup) {
        try {
          const described = await admin.describeGroups(['ride-service']);
          const g = described.groups?.[0];
          if (g && Array.isArray(g.members) && g.members.length > 0) return;
        } catch {
          return;
        }
      }
    } catch {
      // broker might still be starting
    }
    await sleep(500);
  }

  throw new Error(
    '[test] ride-service consumer group not found/active.\n' +
      'Start it in another terminal:\n' +
      '  npm run start:ride-service\n' +
      'And ensure it points to Kafka:\n' +
      '  set KAFKA_BROKERS=localhost:29092',
  );
}
