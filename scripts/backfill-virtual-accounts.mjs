#!/usr/bin/env node
/**
 * Gives every real user who is missing a Pouch virtual account one.
 *
 * Why this exists: WhatsApp profile names with emoji ("Timi 🔥") used to be
 * sent to Pouch verbatim, Pouch rejected the customer, and the user ended up
 * with a wallet but no account number to fund it. The gateway now sends a
 * letters-only name — this script runs that same provisioning for everyone
 * the bug already hit. Display names are never touched.
 *
 *   node scripts/run-with-env.cjs node scripts/backfill-virtual-accounts.mjs            → dry run
 *   node scripts/run-with-env.cjs node scripts/backfill-virtual-accounts.mjs --confirm  → provision
 *   … --only-whatsapp     just whatsapp: users
 *   … --user=<id>         one user
 *   … --limit=50          stop after N provisions
 *
 * Needs a built tree (`npm run build`) — it imports the gateway's own
 * provisioning function so there is exactly one code path that talks to Pouch.
 * Skips seeded, parked and platform users; run the seed purge first so no
 * Pouch customer is ever created for a fictional person.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/client');
const { PouchLiquifiaClient, pouchNameParts } = require('../packages/pouch-client/dist/index.js');
const { provisionPouchAccount } = require('../apps/api-gateway/dist/onboarding/user-onboarding.js');

const args = Object.fromEntries(
  process.argv.slice(2).map((raw) => {
    const [key, value] = raw.replace(/^--/, '').split('=');
    return [key, value ?? true];
  }),
);
const CONFIRM = args.confirm === true;
const ONLY_WHATSAPP = args['only-whatsapp'] === true;
const LIMIT = args.limit ? Number(args.limit) : Infinity;
const USER_ID = typeof args.user === 'string' ? args.user : null;

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL missing — run through scripts/run-with-env.cjs');
  process.exit(1);
}
const apiKey = process.env.POUCH_LIQUIFIA_API_KEY;
if (CONFIRM && !apiKey) {
  console.error('POUCH_LIQUIFIA_API_KEY missing — cannot provision');
  process.exit(1);
}

const prisma = new PrismaClient();
const pouch = new PouchLiquifiaClient({
  baseUrl: process.env.POUCH_LIQUIFIA_BASE_URL || 'https://fiat-api.pouchfinance.xyz/api/v1',
  apiKey: apiKey ?? 'dry-run',
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const users = await prisma.user.findMany({
  where: {
    ...(USER_ID ? { id: USER_ID } : {}),
    virtualAccount: null,
    NOT: [
      { privyDid: { startsWith: 'seed:' } },
      { privyDid: { startsWith: 'parked:' } },
      { privyDid: { startsWith: 'platform:' } },
    ],
    ...(ONLY_WHATSAPP ? { privyDid: { startsWith: 'whatsapp:' } } : {}),
  },
  select: { id: true, name: true, phone: true, email: true, privyDid: true, pouchCustomerId: true, createdAt: true },
  orderBy: { createdAt: 'asc' },
});

const hasContact = (u) => Boolean(u.phone || u.email);
const eligible = users.filter(hasContact);
const noContact = users.filter((u) => !hasContact(u));

console.log(`\n${users.length} real user(s) without a virtual account${CONFIRM ? '' : ' (dry run)'}\n`);
for (const u of users) {
  const { firstName, lastName } = pouchNameParts(u.name);
  console.log(
    `  ${u.id}  ${u.privyDid.padEnd(28)}  ${JSON.stringify(u.name ?? '')}  →  ${firstName} ${lastName}` +
      (u.pouchCustomerId ? '  (customer exists)' : '') +
      (hasContact(u) ? '' : '  (no phone or email — skipped; provisions when they verify a phone)'),
  );
}
if (noContact.length) {
  console.log(`\n  ${noContact.length} skipped: Pouch needs a phone or email, and these accounts have neither.`);
}

if (!CONFIRM) {
  console.log('\nRe-run with --confirm to provision.\n');
  await prisma.$disconnect();
  process.exit(0);
}

let ok = 0;
let failed = 0;
for (const u of eligible.slice(0, LIMIT)) {
  try {
    await provisionPouchAccount(pouch, u.id, u.name ?? undefined, u.phone ?? undefined);
    const va = await prisma.virtualAccount.findUnique({ where: { userId: u.id } });
    ok += 1;
    console.log(`  ✓ ${u.id}  ${JSON.stringify(u.name ?? '')}  ${va?.bankName ?? '?'} ${va?.accountNumber ?? '?'}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${u.id}  ${JSON.stringify(u.name ?? '')}  ${error instanceof Error ? error.message : error}`);
  }
  await sleep(300);
}

console.log(`\nprovisioned ${ok}, failed ${failed}\n`);
await prisma.$disconnect();
process.exit(failed ? 1 : 0);
