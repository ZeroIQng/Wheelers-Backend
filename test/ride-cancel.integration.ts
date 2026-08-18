/**
 * Integration check for the two cancellation paths, run against the live
 * services (Kafka + Postgres + ride-service).
 *
 * These two behave in opposite ways and the difference is easy to break,
 * because RIDE_CANCELLED is handled by two consumers in sequence:
 *
 *   driver cancels → ride goes BACK INTO MATCHING and is re-broadcast,
 *                    and must NOT be written as CANCELLED
 *   rider cancels  → ride really ends and IS written as CANCELLED
 *
 * Test 1 also asserts the departing driver is not re-offered the ride they
 * just walked away from.
 */
import { Kafka, Partitioners } from 'kafkajs';
import type { Producer } from 'kafkajs';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

process.env['KAFKAJS_NO_PARTITIONER_WARNING'] ??= '1';
process.env['DATABASE_URL'] ??=
  'postgresql://postgres:postgres@localhost:5432/wheelers';

const brokers = (process.env['KAFKA_BROKERS'] ?? 'localhost:29092')
  .split(',')
  .map((b) => b.trim())
  .filter(Boolean);

const RIDE_EVENTS = 'ride.events';

const PICKUP = { lat: 6.5244, lng: 3.3792, address: 'Test Pickup' };
const DESTINATION = { lat: 6.605, lng: 3.3492, address: 'Test Destination' };

type OfferSeen = { driverId: string; rideId: string; at: number };

const failures: string[] = [];

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    return;
  }
  failures.push(label + (detail ? ` — ${detail}` : ''));
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
}

async function main(): Promise<void> {
  const stamp = Date.now();
  const kafka = new Kafka({ clientId: `cancel-test-${stamp}`, brokers });
  const producer = kafka.producer({
    allowAutoTopicCreation: true,
    createPartitioner: Partitioners.LegacyPartitioner,
  });
  const consumer = kafka.consumer({ groupId: `cancel-test-${stamp}` });
  const admin = kafka.admin();
  const prisma = new PrismaClient();

  const offers: OfferSeen[] = [];

  try {
    await admin.connect();
    await producer.connect();
    await consumer.connect();
    await prisma.$connect();
  } catch (err) {
    console.error('[test] Could not reach Kafka/Postgres.');
    console.error('[test] brokers:', brokers.join(','));
    throw err;
  }

  await consumer.subscribe({ topic: RIDE_EVENTS, fromBeginning: false });
  await consumer.run({
    eachMessage: async ({ message }) => {
      const raw = message.value?.toString('utf8');
      if (!raw) return;
      let parsed: any;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return;
      }
      if (parsed?.eventType === 'RIDE_OFFER_SENT') {
        offers.push({
          driverId: parsed.driverId,
          rideId: parsed.rideId,
          at: Date.now(),
        });
      }
    },
  });

  // Give the consumer a moment to join before anything is published.
  await settle(3000);

  try {
    await runDriverCancelCase({ prisma, producer, offers });
    await runRiderCancelCase({ prisma, producer });
  } finally {
    await consumer.disconnect().catch(() => {});
    await producer.disconnect().catch(() => {});
    await admin.disconnect().catch(() => {});
    await prisma.$disconnect().catch(() => {});
  }

  console.log('');
  if (failures.length > 0) {
    console.error(`FAILED (${failures.length}):`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log('All cancellation checks passed.');
}

/**
 * Driver cancels after being assigned. The ride must survive: back to
 * MATCHING, re-broadcast, and never offered to the driver who left.
 */
async function runDriverCancelCase(ctx: {
  prisma: PrismaClient;
  producer: Producer;
  offers: OfferSeen[];
}): Promise<void> {
  console.log('\nCase 1 — driver cancels after accepting');

  const ids = await seed(ctx.prisma, 'driver-cancel');
  const { rideId, riderId, driverId, driverUserId, otherDriverId } = ids;

  await publishRideRequested(ctx.producer, { rideId, riderId });
  await waitFor(() => ctx.offers.some((o) => o.rideId === rideId), 15000);

  await assignDriver(ctx.producer, { rideId, riderId, driverId, driverUserId });
  const assigned = await waitFor(
    async () => (await rideStatus(ctx.prisma, rideId)) === 'DRIVER_ASSIGNED',
    15000,
  );
  check('driver assignment persisted before cancelling', assigned);

  const offersBefore = ctx.offers.filter((o) => o.rideId === rideId).length;

  await ctx.producer.send({
    topic: RIDE_EVENTS,
    messages: [
      {
        key: rideId,
        value: JSON.stringify({
          eventType: 'RIDE_CANCELLED',
          rideId,
          riderId,
          driverId,
          driverUserId,
          cancelledBy: 'driver',
          reason: 'driver_changed_mind',
          timestamp: new Date().toISOString(),
        }),
      },
    ],
  });

  // Let both RIDE_CANCELLED consumers run to completion.
  await settle(6000);

  const status = await rideStatus(ctx.prisma, rideId);
  check(
    'ride is NOT written as CANCELLED (it is being re-matched)',
    status !== 'CANCELLED',
    `status=${status}`,
  );
  check('ride is back in MATCHING', status === 'MATCHING', `status=${status}`);

  const afterCancel = ctx.offers.filter(
    (o) => o.rideId === rideId && o.driverId === otherDriverId,
  );
  check(
    'ride was re-broadcast to the other driver',
    afterCancel.length > 0,
    `re-offers=${afterCancel.length}`,
  );

  const reofferedToLeaver = ctx.offers
    .filter((o) => o.rideId === rideId && o.driverId === driverId)
    .length;
  check(
    'the driver who cancelled was not re-offered the ride',
    reofferedToLeaver <= offersBefore,
    `offers to leaver: ${reofferedToLeaver}, before cancel: ${offersBefore}`,
  );

  await cleanup(ctx.prisma, ids);
}

/** Rider cancels. The ride genuinely ends and must be recorded CANCELLED. */
async function runRiderCancelCase(ctx: {
  prisma: PrismaClient;
  producer: Producer;
}): Promise<void> {
  console.log('\nCase 2 — rider cancels after agreeing');

  const ids = await seed(ctx.prisma, 'rider-cancel');
  const { rideId, riderId, driverId, driverUserId } = ids;

  await publishRideRequested(ctx.producer, { rideId, riderId });
  await settle(4000);
  await assignDriver(ctx.producer, { rideId, riderId, driverId, driverUserId });
  const assigned = await waitFor(
    async () => (await rideStatus(ctx.prisma, rideId)) === 'DRIVER_ASSIGNED',
    15000,
  );
  check('driver assignment persisted before cancelling', assigned);

  await ctx.producer.send({
    topic: RIDE_EVENTS,
    messages: [
      {
        key: rideId,
        value: JSON.stringify({
          eventType: 'RIDE_CANCELLED',
          rideId,
          riderId,
          driverId,
          cancelledBy: 'rider',
          reason: 'rider_changed_mind',
          timestamp: new Date().toISOString(),
        }),
      },
    ],
  });

  await waitFor(
    async () => (await rideStatus(ctx.prisma, rideId)) === 'CANCELLED',
    12000,
  );

  const status = await rideStatus(ctx.prisma, rideId);
  check('ride IS written as CANCELLED', status === 'CANCELLED', `status=${status}`);

  const ride = await ctx.prisma.ride.findUnique({ where: { id: rideId } });
  check('cancelledAt is stamped', ride?.cancelledAt != null);
  check(
    'it appears in rider history',
    (
      await ctx.prisma.ride.findMany({
        where: { riderId, status: { in: ['COMPLETED', 'CANCELLED'] } },
      })
    ).some((r) => r.id === rideId),
  );

  await cleanup(ctx.prisma, ids);
}

async function publishRideRequested(
  producer: Producer,
  args: { rideId: string; riderId: string },
): Promise<void> {
  await producer.send({
    topic: RIDE_EVENTS,
    messages: [
      {
        key: args.rideId,
        value: JSON.stringify({
          eventType: 'RIDE_REQUESTED',
          rideId: args.rideId,
          riderId: args.riderId,
          pickup: PICKUP,
          destination: DESTINATION,
          stops: [],
          fareEstimateNgn: 3000,
          paymentMethod: 'WALLET',
          riderOfferNgn: 3000,
          suggestedFareNgn: 3000,
          minOfferNgn: 2400,
          ratePerKmNgn: 300,
          plannedDistanceKm: 10,
          plannedDurationSeconds: 1200,
          timestamp: new Date().toISOString(),
        }),
      },
    ],
  });
}

async function assignDriver(
  producer: Producer,
  args: {
    rideId: string;
    riderId: string;
    driverId: string;
    driverUserId: string;
  },
): Promise<void> {
  await producer.send({
    topic: RIDE_EVENTS,
    messages: [
      {
        key: args.rideId,
        value: JSON.stringify({
          eventType: 'RIDE_DRIVER_ASSIGNED',
          rideId: args.rideId,
          riderId: args.riderId,
          driverId: args.driverId,
          driverUserId: args.driverUserId,
          driverName: 'Cancel Test Driver',
          driverRating: 5,
          vehiclePlate: 'TEST-CXL',
          vehicleModel: 'Test Model',
          etaSeconds: 300,
          agreedFareNgn: 3000,
          lockedFareNgn: 3000,
          paymentMethod: 'WALLET',
          timestamp: new Date().toISOString(),
        }),
      },
    ],
  });
}

type Fixtures = {
  rideId: string;
  riderId: string;
  driverId: string;
  driverUserId: string;
  otherDriverId: string;
  otherDriverUserId: string;
};

async function seed(prisma: PrismaClient, label: string): Promise<Fixtures> {
  const ids: Fixtures = {
    rideId: randomUUID(),
    riderId: randomUUID(),
    driverId: randomUUID(),
    driverUserId: randomUUID(),
    otherDriverId: randomUUID(),
    otherDriverUserId: randomUUID(),
  };

  await prisma.user.create({
    data: {
      id: ids.riderId,
      privyDid: `cancel-test-rider-${label}-${ids.riderId}`,
      role: 'RIDER',
      name: 'Cancel Test Rider',
    },
  });

  for (const [driverId, userId, lat] of [
    [ids.driverId, ids.driverUserId, 6.5244],
    [ids.otherDriverId, ids.otherDriverUserId, 6.5246],
  ] as const) {
    await prisma.user.create({
      data: {
        id: userId,
        privyDid: `cancel-test-driver-${label}-${driverId}`,
        role: 'DRIVER',
        name: 'Cancel Test Driver',
        driver: {
          create: {
            id: driverId,
            status: 'ONLINE',
            kycStatus: 'APPROVED',
            lat,
            lng: 3.3792,
            vehiclePlate: 'TEST-CXL',
            vehicleModel: 'Test Model',
          },
        },
      },
    });
  }

  return ids;
}

async function cleanup(prisma: PrismaClient, ids: Fixtures): Promise<void> {
  // Notification rows hold an FK to User — clear them or the user delete
  // fails and the fixture drivers leak into the next run.
  await prisma.notification
    .deleteMany({
      where: {
        userId: { in: [ids.riderId, ids.driverUserId, ids.otherDriverUserId] },
      },
    })
    .catch(() => {});
  await prisma.gpsLog.deleteMany({ where: { rideId: ids.rideId } }).catch(() => {});
  await prisma.rideStop.deleteMany({ where: { rideId: ids.rideId } }).catch(() => {});
  await prisma.ride.deleteMany({ where: { id: ids.rideId } }).catch(() => {});
  await prisma.driver
    .deleteMany({ where: { id: { in: [ids.driverId, ids.otherDriverId] } } })
    .catch(() => {});
  await prisma.user
    .deleteMany({
      where: {
        id: { in: [ids.riderId, ids.driverUserId, ids.otherDriverUserId] },
      },
    })
    .catch(() => {});
}

async function rideStatus(
  prisma: PrismaClient,
  rideId: string,
): Promise<string | null> {
  const ride = await prisma.ride.findUnique({ where: { id: rideId } });
  return ride?.status ?? null;
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await settle(500);
  }
  return false;
}

function settle(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error('[test] fatal', err);
  process.exit(1);
});
