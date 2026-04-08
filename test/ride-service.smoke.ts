import { Kafka, Partitioners } from 'kafkajs';
import { randomUUID } from 'node:crypto';

type Seen = {
  rideAssigned: any | null;
  gpsProcessed: any | null;
  staleWarning: any | null;
};

process.env['KAFKAJS_NO_PARTITIONER_WARNING'] ??= '1';

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
} as const;

async function main(): Promise<void> {
  const kafka = new Kafka({ clientId: `ride-service-test-${Date.now()}`, brokers });
  const producer = kafka.producer({
    allowAutoTopicCreation: true,
    createPartitioner: Partitioners.LegacyPartitioner,
  });
  const consumer = kafka.consumer({ groupId: `ride-service-test-${Date.now()}` });
  const admin = kafka.admin();

  const rideId = randomUUID();
  const riderId = randomUUID();
  const driverId = randomUUID();

  const seen: Seen = {
    rideAssigned: null,
    gpsProcessed: null,
    staleWarning: null,
  };

  try {
    await admin.connect();
    await producer.connect();
    await consumer.connect();
  } catch (err) {
    console.error('[test] Could not connect to Kafka.');
    console.error('[test] Expected broker:', brokers.join(','));
    console.error('[test] If using Docker Compose, run from `infra/`:');
    console.error('[test]   docker-compose up -d zookeeper kafka');
    console.error('[test] Then wait ~10–30s for Kafka to finish leader election.');
    console.error('[test] Host listener should be: localhost:29092');
    throw err;
  }

  await ensureTopics(admin);
  await waitForHealthyCluster(admin);
  await waitForRideServiceGroup(admin);

  await consumer.subscribe({ topic: TOPICS.RIDE_EVENTS, fromBeginning: false });
  await consumer.subscribe({ topic: TOPICS.GPS_PROCESSED, fromBeginning: false });
  await consumer.subscribe({ topic: TOPICS.COMPLIANCE_EVENTS, fromBeginning: false });

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
    },
  });

  const nowIso = () => new Date().toISOString();

  console.log(`[test] brokers=${brokers.join(',')}`);
  console.log(`[test] rideId=${rideId}`);
  console.log(`[test] driverId=${driverId}`);
  console.log(`[test] riderId=${riderId}`);

  // 1) Put a driver online (so matching can succeed)
  await producer.send({
    topic: TOPICS.DRIVER_EVENTS,
    messages: [
      {
        key: driverId,
        value: JSON.stringify({
          eventType: 'DRIVER_ONLINE',
          driverId,
          walletAddress: '0x0000000000000000000000000000000000000000',
          lat: 6.5244,
          lng: 3.3792,
          vehiclePlate: 'TEST-123',
          vehicleModel: 'Test Model',
          timestamp: nowIso(),
        }),
      },
    ],
  });

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
          riderWallet: '0x0000000000000000000000000000000000000000',
          pickup: { lat: 6.5244, lng: 3.3792, address: 'Pickup' },
          destination: { lat: 6.535, lng: 3.4, address: 'Destination' },
          fareEstimateUsdt: 2.5,
          paymentMethod: 'wallet_balance',
          timestamp: nowIso(),
        }),
      },
    ],
  });

  await waitFor(() => !!seen.rideAssigned, 15_000, 'RIDE_DRIVER_ASSIGNED');
  console.log('[test] got RIDE_DRIVER_ASSIGNED');

  // 3) Send one GPS ping and expect gps.processed
  await producer.send({
    topic: TOPICS.GPS_STREAM,
    messages: [
      {
        key: driverId,
        value: JSON.stringify({
          eventType: 'GPS_UPDATE',
          rideId,
          driverId,
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

  console.log('[test] PASS');
  await producer.disconnect();
  await consumer.disconnect();
  await admin.disconnect();
  process.exit(0);
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
