#!/usr/bin/env node
/**
 * Platform treasury account management.
 *
 *   node scripts/pouch-treasury.mjs create
 *     → creates (or finds) the "Wheelers Treasury" customer + virtual
 *       account, prints the VA id (for POUCH_TREASURY_VIRTUAL_ACCOUNT_ID in
 *       .env) and the bank account number to fund it by transfer.
 *
 *   node scripts/pouch-treasury.mjs balance
 *     → prints the treasury balance (reads the id from .env).
 *
 *   node scripts/pouch-treasury.mjs payout 5000
 *     → pays ₦5,000 of platform revenue from the treasury to the owner's
 *       verified OPay account (destination hardcoded below).
 */
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);

const KEY = env.POUCH_LIQUIFIA_API_KEY;
const BASE = env.POUCH_LIQUIFIA_BASE_URL || 'https://fiat-api.pouchfinance.xyz/api/v1';
if (!KEY) { console.error('POUCH_LIQUIFIA_API_KEY missing from .env'); process.exit(1); }

async function api(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${KEY}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) {
    throw new Error(`${path} → ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  }
  return json.data ?? json;
}

const TREASURY_REFERENCE = 'wheelers-treasury';
const mode = process.argv[2];

if (mode === 'create') {
  // Find-or-create the treasury customer.
  let customer = null;
  try {
    customer = await api(`/customers/reference/${TREASURY_REFERENCE}`);
  } catch { /* not found — create */ }
  if (!customer?.id) {
    customer = await api('/customers', {
      method: 'POST',
      body: JSON.stringify({
        customer_reference: TREASURY_REFERENCE,
        first_name: 'Wheelers',
        last_name: 'Treasury',
        email: 'treasury@wheelersng.com',
      }),
    });
  }
  console.log(`Treasury customer: ${customer.id}`);

  // Find-or-create its virtual account.
  let va = null;
  try {
    const existing = await api(`/customers/${customer.id}/virtual-accounts`);
    const items = Array.isArray(existing) ? existing : existing?.items ?? existing?.virtual_accounts ?? [];
    va = items[0] ?? (existing?.id ? existing : null);
  } catch { /* none yet */ }
  if (!va?.id) {
    va = await api(`/customers/${customer.id}/virtual-accounts`, {
      method: 'POST',
      headers: { 'X-Idempotency-Key': TREASURY_REFERENCE },
      body: JSON.stringify({ country: 'NG', currency: 'NGN' }),
    });
  }

  console.log('');
  console.log('════════════════════════════════════════════');
  console.log(`  Treasury VA id:   ${va.id}`);
  console.log(`  Fund by transfer: ${va.account_number} (${va.bank_name ?? ''})`);
  console.log('════════════════════════════════════════════');
  console.log('');
  console.log('Add to .env on the SERVER and restart api-gateway:');
  console.log(`  POUCH_TREASURY_VIRTUAL_ACCOUNT_ID=${va.id}`);
} else if (mode === 'balance') {
  const id = env.POUCH_TREASURY_VIRTUAL_ACCOUNT_ID;
  if (!id) { console.error('POUCH_TREASURY_VIRTUAL_ACCOUNT_ID not in .env — run create first.'); process.exit(1); }
  const b = await api(`/virtual-accounts/${id}/balance`);
  console.log(`Treasury balance: ₦${(Number(b.balance ?? 0) / 100).toLocaleString()}`);
} else if (mode === 'payout') {
  const OWNER_ACCOUNT = '7013201290'; // OLUWATIMILEHIN HARRY OLOWU @ OPay (verified)
  const id = env.POUCH_TREASURY_VIRTUAL_ACCOUNT_ID;
  if (!id) { console.error('POUCH_TREASURY_VIRTUAL_ACCOUNT_ID not in .env — run create first.'); process.exit(1); }
  const amountNgn = Math.floor(Number(process.argv[3]));
  if (!Number.isFinite(amountNgn) || amountNgn <= 0) {
    console.error('Usage: node scripts/pouch-treasury.mjs payout <amountNgn>');
    process.exit(1);
  }

  const banksRes = await api(`/banks?country=NG&currency=NGN`);
  const banks = banksRes.banks ?? [];
  const opay = banks.find((b) => (b.name ?? '').toLowerCase().includes('opay'));
  if (!opay) { console.error('OPay not found in bank list'); process.exit(1); }

  const verified = await api(`/payouts/validate`, {
    method: 'POST',
    body: JSON.stringify({ account_number: OWNER_ACCOUNT, bank_uuid: opay.uuid, country: 'NG', currency: 'NGN' }),
  });
  console.log(`Paying ₦${amountNgn.toLocaleString()} to ${verified.account_name} (${OWNER_ACCOUNT} @ ${opay.name})…`);

  const payout = await api(`/payouts`, {
    method: 'POST',
    headers: { 'X-Idempotency-Key': `treasury-payout-${Date.now()}` },
    body: JSON.stringify({
      virtual_account_id: id,
      reference: `treasury-payout-${Date.now()}`,
      amount: amountNgn,
      destination_account: OWNER_ACCOUNT,
      destination_bank_uuid: opay.uuid,
      country: 'NG',
      currency: 'NGN',
      narration: 'Wheelers platform revenue',
    }),
  });
  console.log(`✅ payout ${payout.id} (${payout.status})`);
} else {
  console.log('Usage: node scripts/pouch-treasury.mjs create | balance | payout <amountNgn>');
}
