/**
 * Seeds the sandbox with a matched pair: one funded rider, one approved
 * driver parked at Opebi. Idempotent — re-running signs the same users in.
 * Writes credentials/tokens to scripts/sandbox/.sandbox-state.json for the
 * simulators and for signing into the mobile apps.
 */
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SANDBOX } from './sandbox-env.mjs';

process.env.DATABASE_URL = SANDBOX.databaseUrl;
const { prisma } = await import('@wheleers/db');

const here = dirname(fileURLToPath(import.meta.url));
const OPEBI = { lat: 6.6018, lng: 3.3515 };
const RIDER_FUND_NGN = 100_000;

async function waitForGateway() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`${SANDBOX.baseUrl}/health`);
      if (response.ok) return;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Gateway not reachable at ${SANDBOX.baseUrl} — is \`npm run sandbox\` running?`);
}

async function signupOrSignin({ username, password, role, name, phone, email }) {
  const signup = await fetch(`${SANDBOX.baseUrl}/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password, role, fullName: name, phone, email }),
  });
  if (signup.status === 201) {
    const body = await signup.json();
    return { token: body.accessToken, user: body.user, fresh: true };
  }
  const signin = await fetch(`${SANDBOX.baseUrl}/auth/signin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: username, password }),
  });
  if (!signin.ok) {
    throw new Error(`Could not sign up or sign in ${username}: ${signin.status} ${await signin.text()}`);
  }
  const body = await signin.json();
  return { token: body.accessToken, user: body.user, fresh: false };
}

await waitForGateway();

const rider = await signupOrSignin({
  username: 'sandbox_rider', password: 'sandbox123', role: 'RIDER',
  name: 'Sandbox Rider', phone: '+2348000000101', email: 'sandbox.rider@test.local',
});
const driver = await signupOrSignin({
  username: 'sandbox_driver', password: 'sandbox123', role: 'DRIVER',
  name: 'Sandbox Driver', phone: '+2348000000102', email: 'sandbox.driver@test.local',
});

// Matching only considers ONLINE + KYC-APPROVED drivers with coordinates, and
// there is no KYC/API path that gets there without real document uploads.
const driverRow = await prisma.driver.update({
  where: { userId: driver.user.id },
  data: {
    status: 'ONLINE',
    kycStatus: 'APPROVED',
    lat: OPEBI.lat,
    lng: OPEBI.lng,
    lastSeenAt: new Date(),
    vehiclePlate: 'SBX-001-AA',
    vehicleModel: 'Toyota Corolla',
  },
});

// Fund the rider's wallet directly — there is no dev top-up endpoint and the
// real one is a bank webhook.
const wallet = await prisma.wallet.findUnique({ where: { userId: rider.user.id } });
if (!wallet) throw new Error('Rider wallet missing — did wallet creation fail during signup?');
let balance = Number(wallet.balanceNgn);
if (balance < RIDER_FUND_NGN) {
  const updated = await prisma.wallet.update({
    where: { id: wallet.id },
    data: { balanceNgn: { increment: RIDER_FUND_NGN } },
  });
  balance = Number(updated.balanceNgn);
  await prisma.transaction.create({
    data: {
      walletId: wallet.id,
      type: 'DEPOSIT',
      direction: 'CREDIT',
      amountNgn: RIDER_FUND_NGN,
      balanceAfterNgn: balance,
      referenceId: `sandbox-seed-${Date.now()}`,
    },
  });
}

const state = {
  baseUrl: SANDBOX.baseUrl,
  rider: { username: 'sandbox_rider', password: 'sandbox123', userId: rider.user.id, token: rider.token },
  driver: {
    username: 'sandbox_driver', password: 'sandbox123',
    userId: driver.user.id, driverId: driverRow.id, token: driver.token,
  },
};
writeFileSync(resolve(here, '.sandbox-state.json'), JSON.stringify(state, null, 2));

console.log(`
Sandbox seeded.
  Rider  : sandbox_rider / sandbox123   (wallet ₦${balance.toLocaleString('en-NG')})
  Driver : sandbox_driver / sandbox123  (ONLINE, KYC approved, at Opebi, Corolla SBX-001-AA)

Sign into the mobile apps with those credentials, or run the simulators:
  npm run sandbox:e2e | sandbox:driver | sandbox:rider
`);
await prisma.$disconnect();
