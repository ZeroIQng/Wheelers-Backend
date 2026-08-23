#!/usr/bin/env node
/**
 * Master withdrawal from Pouch to a bank account — two deliberate steps:
 *
 *   node scripts/pouch-withdraw.mjs check
 *     → lists every virtual account + balance, totals them, resolves the
 *       destination account NAME at OPay. Read-only. Run this first.
 *
 *   node scripts/pouch-withdraw.mjs send --yes
 *     → creates a payout of each positive balance to the destination.
 *       Refuses to run without --yes.
 *
 * Destination is fixed below on purpose — change it in code, not argv,
 * so a typo'd flag can never redirect the money.
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const DESTINATION_ACCOUNT = '7013201290';
const DESTINATION_BANK_QUERY = 'opay';

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

async function listVirtualAccounts() {
  // Ask Pouch directly — no database needed. Try the direct listing first,
  // then walk customers → their virtual accounts. Print raw responses when a
  // shape is unrecognised so the next fix is informed, not guessed.
  const collected = [];

  const extractItems = (page) =>
    Array.isArray(page)
      ? page
      : page?.virtual_accounts ?? page?.virtualAccounts ?? page?.items ?? page?.accounts ?? page?.results ?? null;

  try {
    const page = await api(`/virtual-accounts?take=100&skip=0`);
    const items = extractItems(page);
    if (Array.isArray(items) && items.length > 0) {
      collected.push(...items);
    } else if (items === null) {
      console.log(`(unrecognised /virtual-accounts shape: ${JSON.stringify(page).slice(0, 300)})`);
    }
  } catch (e) {
    console.log(`(/virtual-accounts listing: ${String(e.message).slice(0, 160)})`);
  }

  if (collected.length === 0) {
    try {
      const page = await api(`/customers?take=100&skip=0`);
      const customers = Array.isArray(page) ? page : page?.customers ?? page?.items ?? page?.results ?? [];
      if (!Array.isArray(customers) || customers.length === 0) {
        console.log(`(unrecognised /customers shape: ${JSON.stringify(page).slice(0, 300)})`);
      } else {
        console.log(`(walking ${customers.length} customers for their virtual accounts…)`);
        for (const customer of customers) {
          const cid = customer.id ?? customer.uuid;
          if (!cid) continue;
          try {
            const vas = await api(`/customers/${cid}/virtual-accounts`);
            const items = extractItems(vas) ?? (vas?.id ? [vas] : []);
            collected.push(...items);
          } catch { /* customer without VAs */ }
        }
      }
    } catch (e) {
      console.log(`(/customers listing: ${String(e.message).slice(0, 160)})`);
    }
  }

  if (collected.length > 0) {
    return collected.map((a) => ({
      id: a.id ?? a.uuid ?? a.virtual_account_id,
      account_number: a.account_number ?? a.accountNumber ?? '',
      account_name: a.account_name ?? a.accountName ?? '',
    }));
  }

  // Fallback: the platform database (works on the server).
  for (const [k, v] of Object.entries(env)) {
    process.env[k] ??= v;
  }
  const { prisma } = await import('@wheleers/db');
  const rows = await prisma.virtualAccount.findMany({
    select: { pouchVirtualAccountId: true, accountNumber: true, accountName: true },
  });
  return rows.map((row) => ({
    id: row.pouchVirtualAccountId,
    account_number: row.accountNumber,
    account_name: row.accountName,
  }));
}

async function resolveDestination() {
  const banksRes = await api(`/banks?country=NG&currency=NGN`);
  const list = banksRes.banks ?? (Array.isArray(banksRes) ? banksRes : []);
  const opay = list.find((b) => (b.name ?? '').toLowerCase().includes(DESTINATION_BANK_QUERY));
  if (!opay) throw new Error(`No bank matching "${DESTINATION_BANK_QUERY}" in Pouch bank list`);

  const verified = await api(`/payouts/validate`, {
    method: 'POST',
    body: JSON.stringify({ account_number: DESTINATION_ACCOUNT, bank_uuid: opay.uuid ?? opay.id, country: 'NG', currency: 'NGN' }),
  });
  return { bank: opay, accountName: verified.account_name ?? null };
}

const mode = process.argv[2];

if (mode === 'check') {
  const dest = await resolveDestination();
  console.log(`Destination: ${DESTINATION_ACCOUNT} @ ${dest.bank.name}`);
  console.log(`Resolves to: ${dest.accountName ?? '❌ ACCOUNT NOT FOUND — do not send'}`);
  console.log('');

  const accounts = await listVirtualAccounts();
  console.log(`Virtual accounts: ${accounts.length}`);
  let total = 0;
  for (const acct of accounts) {
    const id = acct.id ?? acct.uuid;
    let balanceNgn = 0;
    try {
      const b = await api(`/virtual-accounts/${id}/balance`);
      balanceNgn = Number(b.balance ?? 0) / 100; // Pouch reports kobo
    } catch (e) {
      console.log(`  ${id}  (balance unreadable: ${String(e.message).slice(0, 80)})`);
      continue;
    }
    if (balanceNgn > 0) {
      total += balanceNgn;
      console.log(`  ${id}  ${acct.account_number ?? ''}  ${acct.account_name ?? ''}  →  ₦${balanceNgn.toLocaleString()}`);
    }
  }
  console.log(`\nTOTAL withdrawable: ₦${total.toLocaleString()}`);
  console.log('\nIf the name and total look right:  node scripts/pouch-withdraw.mjs send --yes');
  process.exit(0);
} else if (mode === 'send') {
  if (!process.argv.includes('--yes')) {
    console.error('Refusing without --yes. Run "check" first, read the name and total, then re-run with --yes.');
    process.exit(1);
  }
  const dest = await resolveDestination();
  if (!dest.accountName) {
    console.error('Destination account did not resolve to a name — NOT sending.');
    process.exit(1);
  }
  console.log(`Sending everything to ${dest.accountName} (${DESTINATION_ACCOUNT} @ ${dest.bank.name})…\n`);

  const accounts = await listVirtualAccounts();
  let sent = 0;
  for (const acct of accounts) {
    const id = acct.id ?? acct.uuid;
    let balanceNgn = 0;
    try {
      const b = await api(`/virtual-accounts/${id}/balance`);
      balanceNgn = Number(b.balance ?? 0) / 100; // Pouch reports kobo
    } catch { continue; }

    // Flat ₦20 payout fee comes out of the account, so "everything" is
    // balance minus the fee.
    const PAYOUT_FEE_NGN = 20;
    const amountNgn = Math.floor(balanceNgn - PAYOUT_FEE_NGN);
    if (amountNgn <= 0) continue;

    try {
      const payout = await api(`/payouts`, {
        method: 'POST',
        headers: { 'X-Idempotency-Key': randomUUID() },
        body: JSON.stringify({
          virtual_account_id: id,
          reference: `master-sweep-${id}-${Date.now()}`,
          amount: amountNgn,
          destination_account: DESTINATION_ACCOUNT,
          destination_bank_uuid: dest.bank.uuid ?? dest.bank.id,
          country: 'NG',
          currency: 'NGN',
        }),
      });
      sent += amountNgn;
      console.log(`  ✅ ₦${amountNgn.toLocaleString()} from ${id} — payout ${payout.id} (${payout.status})`);
    } catch (e) {
      console.log(`  ❌ ${id}: ${e.message}`);
    }
  }
  console.log(`\nTotal sent: ₦${sent.toLocaleString()}`);
  process.exit(0);
} else {
  console.log('Usage: node scripts/pouch-withdraw.mjs check | send --yes');
}
