#!/usr/bin/env node
/**
 * Keeps the seeded demo *moving*.
 *
 * seed-demo.mjs writes nine months of history and stops — open the admin panel
 * an hour later and the numbers are the same numbers. This script is the other
 * half: a long-running process that walks seeded riders and drivers through
 * real rides in real time, so a ride requested a minute ago is sitting in the
 * LIVE list, "completed today" climbs while you watch, and the activity feed
 * fills with events that carry the same names production emits.
 *
 * Nothing here is fake-shaped. A ride moves REQUESTED → DRIVER_ASSIGNED →
 * DRIVER_EN_ROUTE → ARRIVED → IN_PROGRESS → COMPLETED, the money follows the
 * same fee split the gateway uses (7.5% VAT + ₦30 levy + ₦200 service fee),
 * the rider's balance is locked at match and charged at completion, and the
 * funnel leaks the way a real one does — some requests never find a driver,
 * some riders cancel, some drivers drop the trip.
 *
 * It only ever touches users the seed created (privyDid starts with "seed:"),
 * so it cannot disturb a real account.
 *
 * Usage:
 *   node scripts/demo-live.mjs --confirm                  # run until Ctrl-C
 *   node scripts/demo-live.mjs --confirm --once           # one tick, then exit (cron)
 *   node scripts/demo-live.mjs --confirm --speed=8        # compress trip timings 8x
 *   node scripts/demo-live.mjs --purge --confirm          # remove what this wrote
 *
 * Options:
 *   --interval=20        seconds between ticks
 *   --new-ride-every=60  average seconds between new ride requests
 *   --max-active=8       ride requests in flight at once
 *   --speed=1            time compression; 8 means a 24-min trip finishes in 3
 *   --alert-chance=0.02  odds an in-progress trip raises a safety alert
 *   --duration=3600      stop after this many seconds (default: never)
 *   --database-url=…     defaults to DATABASE_URL from .env
 *
 * A full reset (history + everything this added) is still
 *   node scripts/seed-demo.mjs --purge --confirm
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);

/* ─────────────────────────── args + env ─────────────────────────── */

const args = Object.fromEntries(
  process.argv.slice(2).map((raw) => {
    const [key, value] = raw.replace(/^--/, '').split('=');
    return [key, value ?? true];
  }),
);

const CONFIRM = args.confirm === true;
const PURGE = args.purge === true;
const ONCE = args.once === true;

const INTERVAL_S = Number(args.interval ?? 20);
const NEW_RIDE_EVERY_S = Number(args['new-ride-every'] ?? 60);
const MAX_ACTIVE = Number(args['max-active'] ?? 8);
const SPEED = Math.max(1, Number(args.speed ?? 1));
const ALERT_CHANCE = Number(args['alert-chance'] ?? 0.02);
const DURATION_S = args.duration ? Number(args.duration) : null;

function loadEnvFile() {
  try {
    return Object.fromEntries(
      readFileSync(new URL('../.env', import.meta.url), 'utf8')
        .split(/\r?\n/)
        .filter((line) => line && !line.startsWith('#') && line.includes('='))
        .map((line) => {
          const i = line.indexOf('=');
          return [line.slice(0, i).trim(), line.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')];
        }),
    );
  } catch {
    return {};
  }
}

const env = loadEnvFile();
const DATABASE_URL = args['database-url'] || process.env.DATABASE_URL || env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL not found (pass --database-url=... or set it in .env)');
  process.exit(1);
}

if (!CONFIRM) {
  console.error(
    '\n  This writes live rides and money into the database.\n' +
    '  Re-run with --confirm once you are sure the URL is the one you mean.\n',
  );
  process.exit(1);
}

/* ─────────────────────────── small helpers ─────────────────────────── */

const rand = () => Math.random();
const randInt = (min, max) => Math.floor(rand() * (max - min + 1)) + min;
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const chance = (p) => rand() < p;
const round2 = (v) => Math.round(v * 100) / 100;
const num = (v) => (v == null ? 0 : Number(v));
const ngn = (n) => `₦${Math.round(n).toLocaleString('en-NG')}`;

/* ───────────────────────── pricing (mirrors the gateway) ───────────────────────── */

const RATE_PER_KM_NGN = 300;
const MIN_FARE_NGN = 3000;
const FARE_ROUNDING_INCREMENT = 100;
const VAT_RATE = 0.075;
const LAGOS_STATE_FEE_NGN = 30;
const SERVICE_FEE_NGN = 200;

/** Mirrors packages/config/src/pricing.ts — keep in step if the fee model changes. */
function calculateRideFees(fareNgn) {
  const stateLevyNgn = LAGOS_STATE_FEE_NGN;
  const vatNgn = round2(fareNgn * VAT_RATE);
  const serviceFeeNgn = SERVICE_FEE_NGN;
  const rawPlatformTotalNgn = round2(vatNgn + stateLevyNgn + serviceFeeNgn);
  const rawDriverPayoutNgn = round2(fareNgn - rawPlatformTotalNgn);
  return {
    fareNgn,
    vatNgn,
    stateLevyNgn,
    serviceFeeNgn,
    platformTotalNgn: rawDriverPayoutNgn < 0 ? round2(fareNgn) : rawPlatformTotalNgn,
    driverPayoutNgn: Math.max(0, rawDriverPayoutNgn),
  };
}

function suggestedFare(distanceKm) {
  const raw = RATE_PER_KM_NGN * distanceKm;
  return Math.max(MIN_FARE_NGN, Math.ceil(raw / FARE_ROUNDING_INCREMENT) * FARE_ROUNDING_INCREMENT);
}

const PLATFORM_USER_ID = '00000000-0000-0000-0000-000000000001';

const RIDER_CANCEL_REASONS = [
  'Rider no longer needs the ride',
  'Driver taking too long',
  'Booked by mistake',
];
const DRIVER_CANCEL_REASONS = [
  'Driver could not reach the pickup',
  'Vehicle problem',
  'Rider did not show up',
];
const NO_DRIVER_REASON = 'No driver accepted in time';

const ALERT_KINDS = ['SOS', 'UNSAFE_DRIVING', 'ROUTE_DEVIATION'];

/* ─────────────────────────── the run ─────────────────────────── */

const { PrismaClient } = require('../node_modules/@prisma/client');
const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
const dbLabel = DATABASE_URL.replace(/:\/\/[^@]*@/, '://***@');

/**
 * Every activity row this writes is stamped so `--purge` can find it again.
 * `source` stays the real Kafka topic name, because that is what the admin
 * feed renders — the marker goes in the dedup key and the metadata instead.
 */
async function activity(userId, eventType, source, rideId, metadata, occurredAt = new Date()) {
  try {
    await prisma.userActivityEvent.create({
      data: {
        userId,
        eventType,
        source,
        rideId: rideId ?? null,
        metadata: { ...(metadata ?? {}), demo: true },
        dedupKey: `demo-live:${randomUUID()}`,
        occurredAt,
      },
    });
  } catch (error) {
    console.error(`  ! activity ${eventType} failed: ${error.message}`);
  }
}

/** Wallet row for a user, created on first use exactly as the gateway would. */
async function walletFor(userId) {
  const existing = await prisma.wallet.findUnique({ where: { userId } });
  if (existing) return existing;
  return prisma.wallet.create({ data: { userId, balanceNgn: 0, lockedNgn: 0 } });
}

/**
 * One money movement, with a truthful running balance. Reads the wallet, adds
 * or subtracts, and writes both the new balance and the transaction that
 * explains it — so the ledger the admin panel totals always reconciles.
 */
async function txn(walletId, type, direction, amountNgn, referenceId, metadata) {
  const wallet = await prisma.wallet.findUnique({ where: { id: walletId } });
  if (!wallet) return null;
  const balanceAfter = round2(
    num(wallet.balanceNgn) + (direction === 'CREDIT' ? amountNgn : -amountNgn),
  );
  const [, transaction] = await prisma.$transaction([
    prisma.wallet.update({ where: { id: walletId }, data: { balanceNgn: balanceAfter } }),
    prisma.transaction.create({
      data: {
        walletId,
        type,
        direction,
        amountNgn,
        balanceAfterNgn: balanceAfter,
        referenceId,
        metadata: { ...(metadata ?? {}), seed: true, demo: true },
      },
    }),
  ]);
  return transaction;
}

/** Riders top up when they are short, in the round numbers people actually send. */
async function ensureFunded(userId, walletId, needed) {
  const wallet = await prisma.wallet.findUnique({ where: { id: walletId } });
  if (num(wallet.balanceNgn) >= needed) return 0;
  const shortfall = needed - num(wallet.balanceNgn);
  const topUp = Math.max(5000, Math.ceil((shortfall * (1.2 + rand())) / 1000) * 1000);
  await txn(walletId, 'DEPOSIT', 'CREDIT', topUp, `demo-deposit-${randomUUID()}`, {
    channel: 'virtual_account',
  });
  await activity(userId, 'WALLET_CREDITED', 'wallet.events', null, {
    type: 'DEPOSIT',
    amountNgn: topUp,
  });
  return topUp;
}

/* ─────────────────────── the population we drive ─────────────────────── */

let riders = [];
let driverPool = [];
let routes = [];

async function loadPopulation() {
  const seeded = await prisma.user.findMany({
    where: { privyDid: { startsWith: 'seed:' } },
    select: { id: true, name: true, role: true },
    take: 20000,
  });
  if (seeded.length === 0) {
    throw new Error(
      'no seeded users in this database — run `node scripts/seed-demo.mjs --confirm` first',
    );
  }
  const seededIds = new Set(seeded.map((u) => u.id));

  const drivers = await prisma.driver.findMany({
    where: { userId: { in: [...seededIds] }, kycStatus: 'APPROVED' },
    select: { id: true, userId: true, status: true, lat: true, lng: true, rating: true },
    take: 5000,
  });
  const driverUserIds = new Set(drivers.map((d) => d.userId));

  riders = seeded.filter((u) => !driverUserIds.has(u.id));
  driverPool = drivers;

  // Real routes, sampled from rides that already happened — the geography and
  // the distances stay the ones the seed drew from Lagos, not new invention.
  const sample = await prisma.ride.findMany({
    where: { riderId: { in: riders.slice(0, 500).map((r) => r.id) }, distanceKm: { not: null } },
    select: {
      pickupLat: true, pickupLng: true, pickupAddress: true,
      destLat: true, destLng: true, destAddress: true, distanceKm: true,
    },
    take: 400,
  });
  routes = sample;

  if (routes.length === 0) throw new Error('seeded users have no rides to sample routes from');
  if (driverPool.length === 0) throw new Error('no approved seeded drivers to dispatch');

  console.log(
    `  population: ${riders.length} riders · ${driverPool.length} approved drivers · ${routes.length} routes`,
  );
}

/* ─────────────────────────── the flight deck ─────────────────────────── */

/** rideId -> { stage, dueAt, riderId, driverId, driverUserId, walletId, fareNgn, ... } */
const flights = new Map();
const busyDrivers = new Set();

/**
 * Rides do not live in this process — they live in the database. On start,
 * adopt anything a seeded rider left mid-trip: a previous run that was killed,
 * or the in-flight rides the seed itself wrote. Without this, --once mode (and
 * every restart) would strand rides in REQUESTED forever.
 */
async function adoptInFlight() {
  const riderIds = new Set(riders.map((r) => r.id));
  const open = await prisma.ride.findMany({
    where: {
      riderId: { in: [...riderIds] },
      status: { in: ['REQUESTED', 'MATCHING', 'DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'ARRIVED', 'IN_PROGRESS'] },
    },
    orderBy: { createdAt: 'asc' },
    take: 60,
  });
  if (open.length === 0) return;

  const holds = await prisma.rideHold.findMany({
    where: { rideId: { in: open.map((r) => r.id) }, status: 'ACTIVE' },
  });
  const holdByRide = new Map(holds.map((h) => [h.rideId, h]));
  const driverById = new Map(driverPool.map((d) => [d.id, d]));

  for (const ride of open) {
    const hold = holdByRide.get(ride.id);
    const driver = ride.driverId ? driverById.get(ride.driverId) : null;
    // A matched ride we cannot price or fund is one we cannot settle honestly.
    if (ride.status !== 'REQUESTED' && ride.status !== 'MATCHING' && (!hold || !driver)) continue;

    const stage = ride.status === 'MATCHING' ? 'REQUESTED' : ride.status;
    flights.set(ride.id, {
      stage,
      dueAt: dueIn(randInt(5, 90)),
      riderId: ride.riderId,
      riderName: null,
      bidders: driver ? [driver] : [],
      distanceKm: ride.distanceKm ?? 8,
      estimate: num(ride.fareEstimateNgn) || suggestedFare(ride.distanceKm ?? 8),
      offer: num(ride.riderOfferNgn) || num(ride.fareEstimateNgn),
      pickupAddress: ride.pickupAddress,
      destAddress: ride.destAddress,
      createdAt: ride.createdAt,
      ...(driver
        ? {
            driverId: driver.id,
            driverUserId: driver.userId,
            walletId: hold.walletId,
            fareNgn: num(ride.agreedFareNgn) || num(hold.amountNgn),
            startedAt: ride.startedAt ?? new Date(),
          }
        : {}),
    });
    if (driver) busyDrivers.add(driver.id);
  }
  console.log(`  adopted ${flights.size} rides already in flight`);
}

/** Stage dwell times, in seconds, before --speed compression. */
const DWELL = {
  REQUESTED: () => randInt(20, 90),
  DRIVER_ASSIGNED: () => randInt(30, 120),
  DRIVER_EN_ROUTE: () => randInt(120, 420),
  ARRIVED: () => randInt(40, 180),
  IN_PROGRESS: (distanceKm) => Math.round((distanceKm / 22) * 3600) + randInt(120, 600),
};

const dueIn = (seconds) => new Date(Date.now() + (seconds / SPEED) * 1000);

async function requestRide() {
  const rider = pick(riders);
  const route = pick(routes);
  const distanceKm = round2(route.distanceKm);
  const estimate = suggestedFare(distanceKm);
  // Riders bid a little under the estimate — the negotiation the app is built on.
  const offer = Math.max(
    MIN_FARE_NGN,
    Math.round((estimate * (0.82 + rand() * 0.16)) / 100) * 100,
  );

  const ride = await prisma.ride.create({
    data: {
      riderId: rider.id,
      status: 'REQUESTED',
      paymentMethod: 'WALLET',
      pickupLat: route.pickupLat,
      pickupLng: route.pickupLng,
      pickupAddress: route.pickupAddress,
      destLat: route.destLat,
      destLng: route.destLng,
      destAddress: route.destAddress,
      fareEstimateNgn: estimate,
      riderOfferNgn: offer,
      distanceKm,
    },
  });

  await activity(rider.id, 'RIDE_REQUESTED', 'ride.events', ride.id, {
    pickupAddress: route.pickupAddress,
    destAddress: route.destAddress,
    riderOfferNgn: offer,
    distanceKm,
  });

  // Drivers bid on it — the offers a rider sees before picking one.
  const bidders = [];
  for (let i = 0; i < randInt(1, 3); i += 1) {
    const driver = pick(driverPool);
    if (busyDrivers.has(driver.id) || bidders.some((b) => b.id === driver.id)) continue;
    bidders.push(driver);
    await activity(driver.userId, 'RIDE_OFFER_SENT', 'ride.events', ride.id, {
      priceNgn: Math.round((offer * (1 + rand() * 0.18)) / 100) * 100,
      etaMinutes: randInt(2, 12),
    });
  }

  flights.set(ride.id, {
    stage: 'REQUESTED',
    dueAt: dueIn(DWELL.REQUESTED()),
    riderId: rider.id,
    riderName: rider.name,
    bidders,
    distanceKm,
    estimate,
    offer,
    pickupAddress: route.pickupAddress,
    destAddress: route.destAddress,
    createdAt: ride.createdAt,
  });

  console.log(`  + ${rider.name ?? rider.id.slice(0, 8)} requested ${route.pickupAddress} → ${route.destAddress}  ${ngn(offer)}`);
}

async function matchRide(rideId, flight) {
  // Whoever bid and is still free; failing that, any free driver — an adopted
  // ride from a previous run has no bid list of its own.
  const driver =
    flight.bidders.find((d) => !busyDrivers.has(d.id)) ??
    driverPool.find((d) => !busyDrivers.has(d.id)) ??
    null;
  if (!driver) return expireRide(rideId, flight);

  // The agreed fare lands between what the rider offered and the estimate.
  const fareNgn = Math.round(
    ((flight.offer + (flight.estimate - flight.offer) * rand()) / 100),
  ) * 100;

  const wallet = await walletFor(flight.riderId);
  await ensureFunded(flight.riderId, wallet.id, fareNgn);

  const now = new Date();
  const fresh = await prisma.wallet.findUnique({ where: { id: wallet.id } });
  await prisma.$transaction([
    prisma.ride.update({
      where: { id: rideId },
      data: { status: 'DRIVER_ASSIGNED', driverId: driver.id, agreedFareNgn: fareNgn, matchedAt: now },
    }),
    prisma.rideHold.create({
      data: {
        rideId,
        walletId: wallet.id,
        riderId: flight.riderId,
        driverUserId: driver.userId,
        amountNgn: fareNgn,
        status: 'ACTIVE',
      },
    }),
    // Locking moves money sideways within the wallet, it does not spend it.
    prisma.wallet.update({
      where: { id: wallet.id },
      data: {
        balanceNgn: round2(num(fresh.balanceNgn) - fareNgn),
        lockedNgn: round2(num(fresh.lockedNgn) + fareNgn),
      },
    }),
    prisma.driver.update({ where: { id: driver.id }, data: { status: 'ON_RIDE', lastSeenAt: now } }),
  ]);

  busyDrivers.add(driver.id);
  await activity(flight.riderId, 'RIDE_OFFER_ACCEPTED', 'ride.events', rideId, { agreedFareNgn: fareNgn });
  await activity(driver.userId, 'RIDE_DRIVER_ASSIGNED', 'ride.events', rideId, { agreedFareNgn: fareNgn });
  await activity(flight.riderId, 'WALLET_LOCKED', 'wallet.events', rideId, { amountNgn: fareNgn });

  flights.set(rideId, {
    ...flight,
    stage: 'DRIVER_ASSIGNED',
    dueAt: dueIn(DWELL.DRIVER_ASSIGNED()),
    driverId: driver.id,
    driverUserId: driver.userId,
    walletId: wallet.id,
    fareNgn,
  });
  console.log(`  ✓ matched ${rideId.slice(0, 8)} at ${ngn(fareNgn)}`);
}

/** Nobody bid, or nobody bid in time — the request that never became a ride. */
async function expireRide(rideId, flight) {
  const now = new Date();
  await prisma.ride.update({
    where: { id: rideId },
    data: { status: 'CANCELLED', cancelStage: 'BEFORE_MATCH', cancelReason: NO_DRIVER_REASON, cancelledAt: now },
  });
  await activity(flight.riderId, 'RIDE_BID_TIMEOUT', 'ride.events', rideId, {});
  await activity(flight.riderId, 'RIDE_CANCELLED', 'ride.events', rideId, { reason: NO_DRIVER_REASON });
  flights.delete(rideId);
  console.log(`  – ${rideId.slice(0, 8)} found no driver`);
}

/** A cancellation after a match: the hold is released, nobody is charged. */
async function cancelMatched(rideId, flight, byDriver) {
  const now = new Date();
  const stageMap = {
    DRIVER_ASSIGNED: 'AFTER_MATCH',
    DRIVER_EN_ROUTE: 'DRIVER_EN_ROUTE',
    ARRIVED: 'DRIVER_EN_ROUTE',
    IN_PROGRESS: 'ACTIVE_TRIP',
  };
  const reason = byDriver ? pick(DRIVER_CANCEL_REASONS) : pick(RIDER_CANCEL_REASONS);
  const wallet = await prisma.wallet.findUnique({ where: { id: flight.walletId } });

  await prisma.$transaction([
    prisma.ride.update({
      where: { id: rideId },
      data: {
        status: 'CANCELLED',
        cancelStage: stageMap[flight.stage] ?? 'AFTER_MATCH',
        cancelReason: reason,
        cancelledAt: now,
      },
    }),
    prisma.rideHold.updateMany({
      where: { rideId },
      data: { status: 'RELEASED', settledAmountNgn: 0, settledAt: now },
    }),
    prisma.wallet.update({
      where: { id: flight.walletId },
      data: {
        balanceNgn: round2(num(wallet.balanceNgn) + flight.fareNgn),
        lockedNgn: Math.max(0, round2(num(wallet.lockedNgn) - flight.fareNgn)),
      },
    }),
    prisma.driver.update({ where: { id: flight.driverId }, data: { status: 'ONLINE', lastSeenAt: now } }),
  ]);

  await activity(byDriver ? flight.driverUserId : flight.riderId, 'RIDE_CANCELLED', 'ride.events', rideId, {
    reason,
    cancelledBy: byDriver ? 'driver' : 'rider',
  });
  await activity(flight.riderId, 'WALLET_UNLOCKED', 'wallet.events', rideId, { amountNgn: flight.fareNgn });

  busyDrivers.delete(flight.driverId);
  flights.delete(rideId);
  console.log(`  – ${rideId.slice(0, 8)} cancelled — ${reason}`);
}

async function completeRide(rideId, flight) {
  const now = new Date();
  const fees = calculateRideFees(flight.fareNgn);
  const durationSeconds = Math.max(
    60,
    Math.round((now.getTime() - flight.startedAt.getTime()) / 1000),
  );

  const wallet = await prisma.wallet.findUnique({ where: { id: flight.walletId } });
  await prisma.$transaction([
    prisma.ride.update({
      where: { id: rideId },
      data: {
        status: 'COMPLETED',
        fareFinalNgn: flight.fareNgn,
        platformFeeNgn: fees.platformTotalNgn,
        durationSeconds,
        completedAt: now,
      },
    }),
    prisma.rideHold.updateMany({
      where: { rideId },
      data: { status: 'CHARGED', settledAmountNgn: flight.fareNgn, settledAt: now },
    }),
    // The locked amount is spent: it leaves `lockedNgn`, not `balanceNgn`.
    prisma.wallet.update({
      where: { id: flight.walletId },
      data: { lockedNgn: Math.max(0, round2(num(wallet.lockedNgn) - flight.fareNgn)) },
    }),
    prisma.driver.update({
      where: { id: flight.driverId },
      data: {
        status: 'ONLINE',
        lastSeenAt: now,
        totalRides: { increment: 1 },
        totalEarningsNgn: { increment: fees.driverPayoutNgn },
      },
    }),
  ]);

  // The rider's ledger line for the trip. The balance already moved at match
  // time, so this records the spend without double-debiting the wallet.
  await prisma.transaction.create({
    data: {
      walletId: flight.walletId,
      type: 'RIDE_PAYMENT',
      direction: 'DEBIT',
      amountNgn: flight.fareNgn,
      balanceAfterNgn: num(wallet.balanceNgn),
      referenceId: rideId,
      metadata: { seed: true, demo: true },
    },
  });

  const driverWallet = await walletFor(flight.driverUserId);
  await txn(driverWallet.id, 'DRIVER_PAYOUT', 'CREDIT', fees.driverPayoutNgn, rideId);

  const platformWallet = await walletFor(PLATFORM_USER_ID).catch(() => null);
  if (platformWallet) {
    await txn(platformWallet.id, 'PLATFORM_FEE', 'CREDIT', fees.platformTotalNgn, rideId, {
      vatNgn: fees.vatNgn,
      stateLevyNgn: fees.stateLevyNgn,
      serviceFeeNgn: fees.serviceFeeNgn,
    });
  }

  await activity(flight.riderId, 'RIDE_COMPLETED', 'ride.events', rideId, {
    fareFinalNgn: flight.fareNgn,
    distanceKm: flight.distanceKm,
    durationSeconds,
  });
  await activity(flight.driverUserId, 'RIDE_COMPLETED', 'ride.events', rideId, {
    payoutNgn: fees.driverPayoutNgn,
  });
  await activity(flight.riderId, 'WALLET_DEBITED', 'wallet.events', rideId, { amountNgn: flight.fareNgn });
  await activity(flight.driverUserId, 'WALLET_CREDITED', 'wallet.events', rideId, {
    amountNgn: fees.driverPayoutNgn,
  });

  busyDrivers.delete(flight.driverId);
  flights.delete(rideId);
  console.log(`  ★ completed ${rideId.slice(0, 8)} — ${ngn(flight.fareNgn)} (driver ${ngn(fees.driverPayoutNgn)}, platform ${ngn(fees.platformTotalNgn)})`);
}

async function raiseAlert(rideId, flight) {
  const byDriver = chance(0.3);
  const alert = await prisma.safetyAlert.create({
    data: {
      userId: byDriver ? flight.driverUserId : flight.riderId,
      raisedByRole: byDriver ? 'DRIVER' : 'RIDER',
      kind: pick(ALERT_KINDS),
      status: 'OPEN',
      rideId,
      counterpartUserId: byDriver ? flight.riderId : flight.driverUserId,
      address: flight.destAddress,
      note: 'Raised from the in-trip safety button.',
    },
  });
  await activity(alert.userId, 'SAFETY_ALERT_RAISED', 'compliance.events', rideId, { kind: alert.kind });
  console.log(`  ! safety alert ${alert.kind} on ${rideId.slice(0, 8)}`);
}

/** Advance one ride by exactly one stage. */
async function advance(rideId, flight) {
  const now = new Date();

  switch (flight.stage) {
    case 'REQUESTED': {
      if (chance(0.09)) return expireRide(rideId, flight);
      return matchRide(rideId, flight);
    }
    case 'DRIVER_ASSIGNED': {
      if (chance(0.04)) return cancelMatched(rideId, flight, chance(0.5));
      await prisma.ride.update({ where: { id: rideId }, data: { status: 'DRIVER_EN_ROUTE' } });
      flights.set(rideId, { ...flight, stage: 'DRIVER_EN_ROUTE', dueAt: dueIn(DWELL.DRIVER_EN_ROUTE()) });
      return;
    }
    case 'DRIVER_EN_ROUTE': {
      if (chance(0.03)) return cancelMatched(rideId, flight, chance(0.6));
      await prisma.ride.update({ where: { id: rideId }, data: { status: 'ARRIVED', arrivedAt: now } });
      await activity(flight.driverUserId, 'RIDE_ARRIVED', 'ride.events', rideId, {});
      flights.set(rideId, { ...flight, stage: 'ARRIVED', dueAt: dueIn(DWELL.ARRIVED()) });
      return;
    }
    case 'ARRIVED': {
      if (chance(0.02)) return cancelMatched(rideId, flight, chance(0.7));
      await prisma.ride.update({ where: { id: rideId }, data: { status: 'IN_PROGRESS', startedAt: now } });
      await activity(flight.riderId, 'RIDE_STARTED', 'ride.events', rideId, {});
      flights.set(rideId, {
        ...flight,
        stage: 'IN_PROGRESS',
        startedAt: now,
        dueAt: dueIn(DWELL.IN_PROGRESS(flight.distanceKm)),
      });
      if (chance(ALERT_CHANCE)) await raiseAlert(rideId, { ...flight, startedAt: now });
      return;
    }
    case 'IN_PROGRESS': {
      if (chance(0.01)) return cancelMatched(rideId, flight, false);
      return completeRide(rideId, flight);
    }
    default:
      flights.delete(rideId);
  }
}

/**
 * Drivers coming on and off shift, and the ones already online drifting a
 * little. Without this the online count is frozen and every driver sits on the
 * same pixel of the map.
 */
async function driverChurn() {
  const movers = [];
  for (let i = 0; i < Math.min(6, driverPool.length); i += 1) {
    const driver = pick(driverPool);
    if (busyDrivers.has(driver.id) || movers.some((m) => m.id === driver.id)) continue;
    movers.push(driver);
  }
  const now = new Date();
  for (const driver of movers) {
    const goOnline = driver.status !== 'ONLINE' ? chance(0.6) : !chance(0.15);
    const status = goOnline ? 'ONLINE' : 'OFFLINE';
    await prisma.driver.update({
      where: { id: driver.id },
      data: {
        status,
        lastSeenAt: now,
        ...(driver.lat != null && driver.lng != null
          ? { lat: driver.lat + (rand() - 0.5) * 0.01, lng: driver.lng + (rand() - 0.5) * 0.01 }
          : {}),
      },
    });
    driver.status = status;
    await activity(driver.userId, goOnline ? 'DRIVER_ONLINE' : 'DRIVER_OFFLINE', 'driver.events', null, {});
  }
}

/* ─────────────────────────── loop ─────────────────────────── */

let nextSpawnAt = Date.now();
let stopping = false;

async function tick() {
  const now = Date.now();

  if (now >= nextSpawnAt && flights.size < MAX_ACTIVE) {
    try {
      await requestRide();
    } catch (error) {
      console.error(`  ! could not request a ride: ${error.message}`);
    }
    // Requests do not arrive on a metronome — jitter around the average.
    nextSpawnAt = now + (NEW_RIDE_EVERY_S * (0.5 + rand()) * 1000) / SPEED;
  }

  for (const [rideId, flight] of [...flights.entries()]) {
    if (flight.dueAt.getTime() > now) continue;
    try {
      await advance(rideId, flight);
    } catch (error) {
      console.error(`  ! ${rideId.slice(0, 8)} stalled at ${flight.stage}: ${error.message}`);
      flights.delete(rideId);
      if (flight.driverId) busyDrivers.delete(flight.driverId);
    }
  }

  if (chance(0.5)) {
    await driverChurn().catch((error) => console.error(`  ! driver churn: ${error.message}`));
  }
}

async function purge() {
  console.log(`\nRemoving demo-live activity from ${dbLabel} …`);
  const events = await prisma.userActivityEvent.deleteMany({
    where: { dedupKey: { startsWith: 'demo-live:' } },
  });
  const seeded = await prisma.user.findMany({
    where: { privyDid: { startsWith: 'seed:' } },
    select: { id: true },
  });
  const alerts = await prisma.safetyAlert.deleteMany({
    where: { userId: { in: seeded.map((u) => u.id) } },
  });
  console.log(`  ${events.count} activity events, ${alerts.count} safety alerts removed`);
  console.log('  Rides and money it created belong to seeded users — remove those with');
  console.log('  node scripts/seed-demo.mjs --purge --confirm\n');
}

async function main() {
  if (PURGE) return purge();

  console.log(`\nLive demo against ${dbLabel}`);
  await loadPopulation();
  await adoptInFlight();
  console.log(
    `  tick every ${INTERVAL_S}s · a new request roughly every ${NEW_RIDE_EVERY_S}s · ` +
    `up to ${MAX_ACTIVE} in flight · ${SPEED}x speed`,
  );
  console.log('  Ctrl-C to stop. Rides left in flight stay in flight.\n');

  await tick();
  if (ONCE) return;

  const startedAt = Date.now();
  await new Promise((resolve) => {
    const timer = setInterval(async () => {
      if (stopping) return;
      if (DURATION_S && Date.now() - startedAt >= DURATION_S * 1000) {
        clearInterval(timer);
        return resolve();
      }
      await tick().catch((error) => console.error(`  ! tick failed: ${error.message}`));
    }, INTERVAL_S * 1000);

    const stop = () => {
      stopping = true;
      clearInterval(timer);
      console.log(`\n  stopping — ${flights.size} rides left in flight\n`);
      resolve();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
}

main()
  .catch((error) => {
    console.error('\nDemo run failed:', error.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
