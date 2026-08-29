/**
 * Protocol-level actors for the Wheelers sandbox. They speak the SAME
 * WebSocket protocol the mobile apps do — so a scenario here exercises the
 * gateway, ride-service, and wallet-service exactly the way production
 * traffic does, with no device, no GPS and no San Francisco.
 *
 *   node scripts/sandbox/sim.mjs e2e            # full booking, asserted, exit 0/1
 *   node scripts/sandbox/sim.mjs driver         # act as the seeded driver (auto-bids)
 *   node scripts/sandbox/sim.mjs rider [offer]  # act as the seeded rider (auto-accepts)
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

import { SANDBOX } from './sandbox-env.mjs';

const here = dirname(fileURLToPath(import.meta.url));

const OPEBI = { lat: 6.6018, lng: 3.3515, address: '102 Opebi Rd, Opebi, Ikeja, Lagos' };
const SURULERE = { lat: 6.4969, lng: 3.3556, address: '15 Aiyetoro St, Surulere, Lagos' };

const startedAt = Date.now();
function stamp() {
  return `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
}

// ── HTTP helpers ───────────────────────────────────────────────────────────

async function api(path, { method = 'GET', token, body } = {}) {
  const response = await fetch(`${SANDBOX.baseUrl}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, body: payload };
}

async function signup({ username, password, role, name, phone }) {
  const created = await api('/auth/signup', {
    method: 'POST',
    body: { username, password, role, fullName: name, phone },
  });
  if (created.status === 201) return { token: created.body.accessToken, user: created.body.user };
  const signin = await api('/auth/signin', { method: 'POST', body: { identifier: username, password } });
  if (signin.status !== 200) throw new Error(`auth failed for ${username}: ${JSON.stringify(signin.body)}`);
  return { token: signin.body.accessToken, user: signin.body.user };
}

// ── Actor: a logged, awaitable WebSocket ───────────────────────────────────

class Actor {
  constructor(label, token) {
    this.label = label;
    this.token = token;
    this.frames = [];
    this.waiters = [];
    this.socket = null;
  }

  connect() {
    return new Promise((resolveConnect, reject) => {
      const url = `${SANDBOX.baseUrl.replace('http', 'ws')}/ws?token=${encodeURIComponent(this.token)}`;
      this.socket = new WebSocket(url);
      this.socket.on('open', () => {
        console.log(`[${stamp()}] ${this.label} ▸ connected`);
        resolveConnect();
      });
      this.socket.on('error', reject);
      this.socket.on('message', (raw) => {
        let frame;
        try { frame = JSON.parse(String(raw)); } catch { return; }
        this.frames.push(frame);
        const summary = JSON.stringify(frame.payload ?? {});
        console.log(`[${stamp()}] ${this.label} ◂ ${frame.type} ${summary.length > 140 ? `${summary.slice(0, 140)}…` : summary}`);
        for (const waiter of [...this.waiters]) {
          if (waiter.matches(frame)) {
            this.waiters.splice(this.waiters.indexOf(waiter), 1);
            clearTimeout(waiter.timer);
            waiter.resolve(frame);
          }
        }
      });
    });
  }

  send(type, payload) {
    console.log(`[${stamp()}] ${this.label} ▸ ${type}`);
    this.socket.send(JSON.stringify({ type, payload }));
  }

  /** Resolves with the first (past or future) frame of `type` matching `predicate`. */
  waitFor(type, { predicate = () => true, timeoutMs = 20_000, description } = {}) {
    const matches = (frame) => frame.type === type && predicate(frame.payload ?? {});
    const seen = this.frames.find(matches);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolveWait, reject) => {
      const waiter = { matches, resolve: resolveWait };
      waiter.timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(new Error(`${this.label}: timed out waiting for ${description ?? type}`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  close() {
    this.socket?.close();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Driver behaviour ───────────────────────────────────────────────────────

/** Go online and answer one complete trip: bid → arrive → start → gps → end. */
async function driveOneTrip(driver, { bidNgn, position = OPEBI, keepGoing = false } = {}) {
  driver.send('driver:online', { lat: position.lat, lng: position.lng });
  await driver.waitFor('driver:online:accepted');

  do {
    const offer = await driver.waitFor('ride:offer', { timeoutMs: 30_000 });
    const { rideId, riderId, riderOfferNgn, fareEstimateNgn, destination } = offer.payload;
    const amount = bidNgn ?? riderOfferNgn ?? fareEstimateNgn;

    await sleep(400);
    driver.send('driver:accept', { rideId, riderId, agreedFareNgn: amount, etaSeconds: 120 });
    await driver.waitFor('driver:accept:accepted', { predicate: (p) => p.rideId === rideId });

    const matched = await driver.waitFor('ride:matched', {
      predicate: (p) => p.rideId === rideId,
      timeoutMs: 60_000,
      description: 'ride:matched (rider must accept within 60s)',
    });
    const agreedFare = matched.payload.agreedFareNgn ?? amount;

    await sleep(600);
    driver.send('ride:arrived', { rideId });
    await driver.waitFor('ride:arrived:ack', { predicate: (p) => p.rideId === rideId || !p.rideId });

    await sleep(600);
    driver.send('ride:start', { rideId, riderId, lockedFareNgn: agreedFare });

    // Three GPS ticks marching toward the drop-off.
    const target = destination ?? SURULERE;
    for (let step = 1; step <= 3; step += 1) {
      await sleep(500);
      driver.send('driver:gps', {
        rideId,
        lat: position.lat + ((target.lat - position.lat) * step) / 3,
        lng: position.lng + ((target.lng - position.lng) * step) / 3,
        speedKmh: 42,
        timestamp: new Date().toISOString(),
      });
    }

    await sleep(500);
    driver.send('ride:end', { rideId, riderId, fareNgn: agreedFare, endedBy: 'both_confirmed' });
    await driver.waitFor('ride:completed', { predicate: (p) => p.rideId === rideId, timeoutMs: 30_000 });
    console.log(`[${stamp()}] ${driver.label} ✓ trip ${rideId.slice(0, 8)} complete (₦${agreedFare})`);
  } while (keepGoing);
}

// ── Rider behaviour ────────────────────────────────────────────────────────

/** Request a ride, accept the first bid, ride it to completion. */
async function rideOnce(rider, { offerNgn = 6000, pickup = OPEBI, destination = SURULERE } = {}) {
  rider.send('ride:request', {
    pickup, destination, paymentMethod: 'WALLET', offerNgn,
  });
  const accepted = await rider.waitFor('ride:request:accepted', {
    timeoutMs: 15_000,
    description: 'ride:request:accepted (offer may be below minimum fare)',
  });
  const { rideId } = accepted.payload;

  const bid = await rider.waitFor('ride:counter_offer', {
    predicate: (p) => p.rideId === rideId,
    timeoutMs: 30_000,
    description: 'a driver bid (is a driver online near the pickup?)',
  });

  await sleep(400);
  rider.send('ride:accept_offer', {
    rideId,
    driverId: bid.payload.driverId,
    driverUserId: bid.payload.driverUserId,
    agreedFareNgn: bid.payload.counterOfferNgn,
    paymentMethod: 'WALLET',
  });

  await rider.waitFor('ride:matched', { predicate: (p) => p.rideId === rideId, timeoutMs: 30_000 });
  await rider.waitFor('ride:driver_arrived', { predicate: (p) => p.rideId === rideId, timeoutMs: 60_000 });
  await rider.waitFor('ride:started', { predicate: (p) => p.rideId === rideId, timeoutMs: 60_000 });
  const completed = await rider.waitFor('ride:completed', { predicate: (p) => p.rideId === rideId, timeoutMs: 120_000 });
  console.log(`[${stamp()}] ${rider.label} ✓ ride ${rideId.slice(0, 8)} complete (₦${completed.payload.fareNgn})`);
  return { rideId, agreedFareNgn: bid.payload.counterOfferNgn };
}

// ── Commands ───────────────────────────────────────────────────────────────

function loadState() {
  try {
    return JSON.parse(readFileSync(resolve(here, '.sandbox-state.json'), 'utf8'));
  } catch {
    throw new Error('No sandbox state — run `npm run sandbox:seed` first.');
  }
}

async function commandDriver() {
  const state = loadState();
  const { token } = await signup({ username: state.driver.username, password: state.driver.password, role: 'DRIVER' });
  const driver = new Actor('driver', token);
  await driver.connect();
  console.log('[sim] driver online at Opebi — will auto-bid on every request. Ctrl+C to stop.');
  await driveOneTrip(driver, { keepGoing: true });
}

async function commandRider(offerArg) {
  const state = loadState();
  const { token } = await signup({ username: state.rider.username, password: state.rider.password, role: 'RIDER' });
  const rider = new Actor('rider', token);
  await rider.connect();
  await rideOnce(rider, { offerNgn: offerArg ? Number(offerArg) : 6000 });
  rider.close();
}

async function commandE2e() {
  // Fresh actors every run: no leftover active rides, no stale resyncs —
  // the scenario is hermetic and repeatable.
  process.env.DATABASE_URL = SANDBOX.databaseUrl;
  const { prisma } = await import('@wheleers/db');
  const runId = Date.now().toString(36);

  const riderAuth = await signup({
    username: `e2e_r_${runId}`, password: 'sandbox123', role: 'RIDER',
    name: 'E2E Rider', phone: '+2348000001001',
  });
  const driverAuth = await signup({
    username: `e2e_d_${runId}`, password: 'sandbox123', role: 'DRIVER',
    name: 'E2E Driver', phone: '+2348000001002',
  });

  await prisma.driver.update({
    where: { userId: driverAuth.user.id },
    data: {
      status: 'ONLINE', kycStatus: 'APPROVED',
      lat: OPEBI.lat, lng: OPEBI.lng, lastSeenAt: new Date(),
      vehiclePlate: 'E2E-001-AA', vehicleModel: 'Toyota Corolla',
    },
  });
  const wallet = await prisma.wallet.findUnique({ where: { userId: riderAuth.user.id } });
  if (!wallet) throw new Error('rider wallet missing after signup');
  await prisma.wallet.update({ where: { id: wallet.id }, data: { balanceNgn: 50_000 } });

  const rider = new Actor('rider ', riderAuth.token);
  const driver = new Actor('driver', driverAuth.token);
  await Promise.all([rider.connect(), driver.connect()]);

  const checks = [];
  const check = (label, ok, detail = '') => {
    checks.push({ label, ok });
    console.log(`  ${ok ? '✓' : '✗'} ${label}${!ok && detail ? ` — ${detail}` : ''}`);
  };

  console.log('\n── E2E: booking a ride, Opebi → Surulere ──\n');
  const driverDone = driveOneTrip(driver);
  const { rideId, agreedFareNgn } = await rideOnce(rider, { offerNgn: 6000 });
  await driverDone;

  // Wallet settlement fans out through Kafka a beat after ride:completed —
  // give those frames a moment to land instead of asserting into the race.
  await Promise.allSettled([
    rider.waitFor('wallet:updated', { predicate: (p) => p.direction === 'debit', timeoutMs: 10_000 }),
    driver.waitFor('wallet:updated', { predicate: (p) => p.direction === 'credit', timeoutMs: 10_000 }),
  ]);

  console.log('\n── Assertions ──');
  const got = (actor, type, predicate = () => true) =>
    actor.frames.some((f) => f.type === type && predicate(f.payload ?? {}));

  check('rider: request acknowledged', got(rider, 'ride:request:accepted'));
  check('driver: received the ride offer', got(driver, 'ride:offer', (p) => p.rideId === rideId));
  check('rider: received the driver bid', got(rider, 'ride:counter_offer', (p) => p.rideId === rideId));
  check('driver: told the rider accepted & paid (ride:offer_accepted)',
    got(driver, 'ride:offer_accepted', (p) => p.rideId === rideId));
  const driverMatch = driver.frames.find((f) => f.type === 'ride:matched' && f.payload?.rideId === rideId);
  check('driver: matched with the full route in the payload',
    Boolean(driverMatch?.payload?.pickup?.address && driverMatch?.payload?.destination?.address),
    'pickup/destination missing — resync-proof matching broken');
  check('rider: saw arrived → started → completed',
    got(rider, 'ride:driver_arrived') && got(rider, 'ride:started') && got(rider, 'ride:completed'));
  check('rider: wallet locked for the fare',
    got(rider, 'wallet:updated', (p) => p.direction === 'lock'));
  check('rider: wallet debited on completion',
    got(rider, 'wallet:updated', (p) => p.direction === 'debit'));
  check('driver: wallet credited with earnings',
    got(driver, 'wallet:updated', (p) => p.direction === 'credit'));

  const riderWallet = await prisma.wallet.findUnique({ where: { userId: riderAuth.user.id } });
  check(`rider: balance is ₦${(50_000 - agreedFareNgn).toLocaleString()} after the ₦${agreedFareNgn} fare`,
    Number(riderWallet?.balanceNgn) === 50_000 - agreedFareNgn,
    `actual ₦${Number(riderWallet?.balanceNgn)}`);

  const bids = await api('/drivers/me/bids', { token: driverAuth.token });
  check('driver: bid recorded in history as ACCEPTED',
    bids.status === 200 && bids.body.items?.some((b) => b.rideId === rideId && b.status === 'ACCEPTED'),
    JSON.stringify(bids.body.items?.map((b) => b.status)));

  const active = await api('/drivers/me/rides/active', { token: driverAuth.token });
  check('driver: no active ride after completion', active.status === 200 && active.body.ride === null);

  rider.close();
  driver.close();
  await prisma.$disconnect();

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${failed.length === 0 ? '✅ E2E PASSED' : '❌ E2E FAILED'} — ${checks.length - failed.length}/${checks.length} checks\n`);
  process.exit(failed.length === 0 ? 0 : 1);
}

const [command, arg] = process.argv.slice(2);
try {
  if (command === 'driver') await commandDriver();
  else if (command === 'rider') await commandRider(arg);
  else if (command === 'e2e') await commandE2e();
  else {
    console.log('usage: sim.mjs e2e | driver | rider [offerNgn]');
    process.exit(2);
  }
} catch (error) {
  console.error(`\n[sim] FAILED: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
