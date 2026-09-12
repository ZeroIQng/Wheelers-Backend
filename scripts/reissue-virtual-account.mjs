#!/usr/bin/env node
/**
 * Re-issue a user's Pouch virtual account under a clean name.
 *
 * Why: before the name sanitizer, a WhatsApp name like "Olá🌸" went to Pouch
 * verbatim. Pouch accepted it, but the bank network mangled the account name
 * into "OlÃƒÂ¡Ã‚Â¸ User" — what anyone sending her money sees. The display
 * name in Wheelers stays as she wrote it; only the bank-facing name changes.
 *
 *   node scripts/run-with-env.cjs node scripts/reissue-virtual-account.mjs --user=<id|phone>            → dry run
 *   node scripts/run-with-env.cjs node scripts/reissue-virtual-account.mjs --user=<id|phone> --confirm  → do it
 *   … --name="Ola Adeyemi"   override the bank-facing name (default: sanitized display name)
 *
 * What it does, in order:
 *   1. Renames the Pouch customer to the clean name.
 *   2. Opens a NEW virtual account for that customer (a new account number).
 *   3. If the new account's name still comes back garbled, opens a fresh Pouch
 *      customer (reference "<userId>:2") and a virtual account under it.
 *   4. Points the user's VirtualAccount row at the new account.
 *
 * The old number is not closed. Money sent to it still reaches the user: the
 * credit webhook falls back to the Pouch customer when it can't match the
 * account, and both accounts belong to the same customer.
 *
 * Needs a built tree (`npm run build`).
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/client');
const { PouchLiquifiaClient, pouchNameParts } = require('../packages/pouch-client/dist/index.js');

const args = Object.fromEntries(
  process.argv.slice(2).map((raw) => {
    const [key, ...rest] = raw.replace(/^--/, '').split('=');
    return [key, rest.length ? rest.join('=') : true];
  }),
);
const CONFIRM = args.confirm === true;
const TARGET = typeof args.user === 'string' ? args.user.trim() : '';
const NAME_OVERRIDE = typeof args.name === 'string' ? args.name : undefined;

if (!TARGET) {
  console.error('--user=<id|phone> is required');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL missing — run through scripts/run-with-env.cjs');
  process.exit(1);
}
const apiKey = process.env.POUCH_LIQUIFIA_API_KEY;
if (CONFIRM && !apiKey) {
  console.error('POUCH_LIQUIFIA_API_KEY missing — cannot talk to Pouch');
  process.exit(1);
}

const prisma = new PrismaClient();
const pouch = new PouchLiquifiaClient({
  baseUrl: process.env.POUCH_LIQUIFIA_BASE_URL || 'https://fiat-api.pouchfinance.xyz/api/v1',
  apiKey: apiKey ?? 'dry-run',
});

/** True when the bank-facing name is plain ASCII letters — nothing mangled. */
const isClean = (accountName) => /^[A-Za-z' -]+$/.test(accountName ?? '');

const looksLikePhone = /^\+?\d{10,15}$/.test(TARGET);
const user = await prisma.user.findFirst({
  where: looksLikePhone
    ? { OR: [{ phone: TARGET }, { phone: TARGET.startsWith('+') ? TARGET : `+${TARGET}` }] }
    : { id: TARGET },
  include: { virtualAccount: true },
});
if (!user) {
  console.error(`no user matches ${TARGET}`);
  process.exit(1);
}

const { firstName, lastName } = pouchNameParts(NAME_OVERRIDE ?? user.name);
const va = user.virtualAccount;

console.log(`\nUser        ${user.id}`);
console.log(`Display     ${JSON.stringify(user.name ?? '')}   (unchanged)`);
console.log(`Phone       ${user.phone ?? '—'}   Email ${user.email ?? '—'}`);
console.log(`Customer    ${user.pouchCustomerId ?? '— (none yet)'}`);
console.log(`Current VA  ${va ? `${va.bankName} ${va.accountNumber}  "${va.accountName}"` : '— (none)'}`);
console.log(`New name    ${firstName} ${lastName}`);

if (!user.pouchCustomerId) {
  console.error('\nThis user has no Pouch customer. Use scripts/backfill-virtual-accounts.mjs instead.\n');
  await prisma.$disconnect();
  process.exit(1);
}
if (!user.phone && !user.email) {
  console.error('\nPouch needs a phone or email on the customer and this user has neither.\n');
  await prisma.$disconnect();
  process.exit(1);
}
if (!CONFIRM) {
  console.log('\nDry run. Re-run with --confirm to issue a new account.\n');
  await prisma.$disconnect();
  process.exit(0);
}

let customerId = user.pouchCustomerId;

// 1. Rename the existing customer. Pouch may or may not honour a name change —
//    if it refuses, step 3 opens a fresh customer instead.
try {
  await pouch.updateCustomer(customerId, { firstName, lastName });
  console.log(`\n✓ customer ${customerId} renamed`);
} catch (error) {
  console.log(`\n… could not rename customer (${error instanceof Error ? error.message : error}); will try a new one if needed`);
}

// 2. New virtual account under the (renamed) customer.
let fresh = await pouch.createVirtualAccount(customerId, {
  country: 'NG',
  currency: 'NGN',
  idempotencyKey: `va-reissue-${user.id}-${Date.now()}`,
});
console.log(`✓ new account ${fresh.bank_name} ${fresh.account_number}  "${fresh.account_name}"`);

// 3. Still garbled → the customer's stored name is what the bank prints, and
//    it cannot be fixed in place. Open a new customer with a suffixed reference.
if (!isClean(fresh.account_name)) {
  const attempt = 2;
  const reference = `${user.id}:${attempt}`;
  console.log(`… account name still not clean; opening a fresh customer (${reference})`);
  const customer = await pouch.createCustomer({
    customerReference: reference,
    firstName,
    lastName,
    phoneNumber: user.phone ?? undefined,
    email: user.email ?? undefined,
  });
  customerId = customer.id;
  fresh = await pouch.createVirtualAccount(customerId, {
    country: 'NG',
    currency: 'NGN',
    idempotencyKey: `va-reissue-${user.id}-${attempt}-${Date.now()}`,
  });
  console.log(`✓ new account ${fresh.bank_name} ${fresh.account_number}  "${fresh.account_name}"`);
  if (!isClean(fresh.account_name)) {
    console.error('\n✗ Pouch still returned a garbled account name. Nothing was changed in our database.\n');
    await prisma.$disconnect();
    process.exit(1);
  }
}

// 4. Point the user at the new account.
await prisma.$transaction(async (tx) => {
  if (customerId !== user.pouchCustomerId) {
    await tx.user.update({ where: { id: user.id }, data: { pouchCustomerId: customerId } });
  }
  const data = {
    pouchCustomerId: customerId,
    pouchVirtualAccountId: fresh.id,
    bankName: fresh.bank_name,
    accountNumber: fresh.account_number,
    accountName: fresh.account_name,
    currency: fresh.currency,
    country: fresh.country,
    status: 'active',
  };
  if (va) {
    await tx.virtualAccount.update({ where: { userId: user.id }, data });
  } else {
    await tx.virtualAccount.create({ data: { userId: user.id, ...data } });
  }
});

console.log(`\nDone. Tell ${JSON.stringify(user.name ?? user.id)} to use:`);
console.log(`  ${fresh.bank_name}  ${fresh.account_number}  (${fresh.account_name})`);
if (va) console.log(`Old number ${va.accountNumber} still credits her wallet if someone uses it.\n`);
await prisma.$disconnect();
