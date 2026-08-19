/**
 * A driver who goes offline and comes straight back must be re-sent any ride
 * request that is still live.
 *
 * Two separate things used to swallow that request: the driver stayed in
 * `pending.candidates` (so onDriverOnline skipped them as "already offered"),
 * and later they were marked in `attemptedDriverIds` on going offline (so
 * onDriverOnline skipped them as "already turned it down"). Either way the
 * driver came back online to an empty screen while the rider was still waiting.
 *
 * Note the whole run must finish inside RIDE.BID_TIMEOUT_SECONDS, because after
 * that the pending match is cleared and there is genuinely nothing to re-send.
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
const DRIVER_EVENTS = 'driver.events';

const PICKUP = { lat: 6.5244, lng: 3.3792, address: 'Reonline Pickup' };
const DESTINATION = { lat: 6.605, lng: 3.3492, address: 'Reonline Destination' };

const failures: string[] = [];

function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  ✓ ${label}`);
    return;
  }
  failures.push(label + (detail ? ` — ${detail}` : ''));
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
}

async function main(): Promise<void> {
  const stamp = Date.now();
  const kafka = new Kafka({ clientId: `reonline-test-${stamp}`, brokers });
  const producer = kafka.producer({
    allowAutoTopicCreation: true,
    createPartitioner: Partitioners.LegacyPartitioner,
  });
  const consumer = kafka.consumer({ groupId: `reonline-test-${stamp}` });
  const prisma = new PrismaClient();

  const offers: Array<{ rideId: string; driverId: string }> = [];

  await producer.connect();
  await consumer.connect();
  await prisma.$connect();

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
        offers.push({ rideId: parsed.rideId, driverId: parsed.driverId });
      }
    },
  });

  await settle(3000);

  const ids = {
    rideId: randomUUID(),
    riderId: randomUUID(),
    driverId: randomUUID(),
    driverUserId: randomUUID(),
  };

  try {
    await seed(prisma, ids);

    console.log('\nDriver goes offline mid-request, then comes back');

    // Announce the driver so ride-service holds them in its in-memory pool.
    await sendDriverEvent(producer, {
      eventType: 'DRIVER_ONLINE',
      driverId: ids.driverId,
      userId: ids.driverUserId,
      lat: PICKUP.lat,
      lng: PICKUP.lng,
      vehiclePlate: 'TEST-RE',
      vehicleModel: 'Test Model',
      timestamp: new Date().toISOString(),
    });
    await settle(2000);

    await publishRideRequested(producer, ids);

    const gotFirst = await waitFor(
      () => offers.some((o) => o.rideId === ids.rideId && o.driverId === ids.driverId),
      15000,
    );
    check('driver receives the request while online', gotFirst);

    const beforeOffline = offers.filter(
      (o) => o.rideId === ids.rideId && o.driverId === ids.driverId,
    ).length;

    await sendDriverEvent(producer, {
      eventType: 'DRIVER_OFFLINE',
      driverId: ids.driverId,
      reason: 'manual',
      timestamp: new Date().toISOString(),
    });
    await settle(2500);

    // Back online while the request is still live.
    await sendDriverEvent(producer, {
      eventType: 'DRIVER_ONLINE',
      driverId: ids.driverId,
      userId: ids.driverUserId,
      lat: PICKUP.lat,
      lng: PICKUP.lng,
      vehiclePlate: 'TEST-RE',
      vehicleModel: 'Test Model',
      timestamp: new Date().toISOString(),
    });

    const resent = await waitFor(
      () =>
        offers.filter(
          (o) => o.rideId === ids.rideId && o.driverId === ids.driverId,
        ).length > beforeOffline,
      12000,
    );

    const afterOnline = offers.filter(
      (o) => o.rideId === ids.rideId && o.driverId === ids.driverId,
    ).length;

    check(
      'the still-live request is re-sent when the driver comes back online',
      resent,
      `offers before offline=${beforeOffline}, after re-online=${afterOnline}`,
    );
  } finally {
    await cleanup(prisma, ids);
    await consumer.disconnect().catch(() => {});
    await producer.disconnect().catch(() => {});
    await prisma.$disconnect().catch(() => {});
  }

  console.log('');
  if (failures.length > 0) {
    console.error(`FAILED (${failures.length}):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('Driver re-online check passed.');
}

async function sendDriverEvent(producer: Producer, event: any): Promise<void> {
  await producer.send({
    topic: DRIVER_EVENTS,
    messages: [{ key: event.driverId, value: JSON.stringify(event) }],
  });
}

async function publishRideRequested(
  producer: Producer,
  ids: { rideId: string; riderId: string },
): Promise<void> {
  await producer.send({
    topic: RIDE_EVENTS,
    messages: [
      {
        key: ids.rideId,
        value: JSON.stringify({
          eventType: 'RIDE_REQUESTED',
          rideId: ids.rideId,
          riderId: ids.riderId,
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

async function seed(
  prisma: PrismaClient,
  ids: { riderId: string; driverId: string; driverUserId: string },
): Promise<void> {
  await prisma.user.create({
    data: {
      id: ids.riderId,
      privyDid: `reonline-rider-${ids.riderId}`,
      role: 'RIDER',
      name: 'Reonline Test Rider',
    },
  });
  await prisma.user.create({
    data: {
      id: ids.driverUserId,
      privyDid: `reonline-driver-${ids.driverId}`,
      role: 'DRIVER',
      name: 'Reonline Test Driver',
      driver: {
        create: {
          id: ids.driverId,
          status: 'ONLINE',
          kycStatus: 'APPROVED',
          lat: PICKUP.lat,
          lng: PICKUP.lng,
          vehiclePlate: 'TEST-RE',
          vehicleModel: 'Test Model',
        },
      },
    },
  });
}

async function cleanup(
  prisma: PrismaClient,
  ids: { rideId: string; riderId: string; driverId: string; driverUserId: string },
): Promise<void> {
  // Notification holds an FK to User — clear it first or the fixtures leak and
  // crowd out later runs, since matchDriver only takes the 5 nearest drivers.
  await prisma.notification
    .deleteMany({ where: { userId: { in: [ids.riderId, ids.driverUserId] } } })
    .catch(() => {});
  await prisma.gpsLog.deleteMany({ where: { rideId: ids.rideId } }).catch(() => {});
  await prisma.rideStop.deleteMany({ where: { rideId: ids.rideId } }).catch(() => {});
  await prisma.ride.deleteMany({ where: { id: ids.rideId } }).catch(() => {});
  await prisma.driver.deleteMany({ where: { id: ids.driverId } }).catch(() => {});
  await prisma.user
    .deleteMany({ where: { id: { in: [ids.riderId, ids.driverUserId] } } })
    .catch(() => {});
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await settle(400);
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
