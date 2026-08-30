import { prisma } from '@wheleers/db';
import { POUCH_PAYOUT_FEE_NGN } from '@wheleers/config';
import type { PouchLiquifiaClient } from '@wheleers/pouch-client';

/**
 * Treasury float sweep.
 *
 * Deposits land in each user's own virtual account, but withdrawals pay out
 * of the TREASURY virtual account's balance — two different vaults. Without
 * a bridge, every deposit strands cash where payouts can't reach it and
 * withdrawals fail with the provider's INSUFFICIENT_BALANCE the moment the
 * treasury runs dry (which, unfunded, is always).
 *
 * This job is the bridge: on an interval it moves every real user VA's
 * balance (minus the flat payout fee) into the treasury's bank account, so
 * float scales with deposits instead of with someone remembering an ops
 * chore. Seeded demo users are skipped; the treasury never sweeps itself;
 * dust below the threshold is left alone so fees don't eat it.
 */

const SWEEP_INTERVAL_MS = Number(process.env.TREASURY_SWEEP_INTERVAL_MS ?? 30 * 60_000);
/** Below this a sweep isn't worth its ₦20 fee. */
const SWEEP_MIN_NGN = Number(process.env.TREASURY_SWEEP_MIN_NGN ?? 1_000);
const TREASURY_ACCOUNT_NUMBER = process.env.POUCH_TREASURY_ACCOUNT_NUMBER ?? '8881728026';
const TREASURY_BANK_QUERY = (process.env.POUCH_TREASURY_BANK_QUERY ?? 'rubies').toLowerCase();

type SweepDeps = {
  pouchLiquifiaClient: PouchLiquifiaClient;
  treasuryVirtualAccountId: string | undefined;
};

export function startTreasurySweep(deps: SweepDeps): void {
  const treasuryVaId = deps.treasuryVirtualAccountId;
  if (!treasuryVaId) {
    console.warn('[treasury-sweep] POUCH_TREASURY_VIRTUAL_ACCOUNT_ID not set — sweep disabled');
    return;
  }

  let running = false;
  let destinationBankUuid: string | null = null;

  const resolveDestination = async (): Promise<string | null> => {
    if (destinationBankUuid) return destinationBankUuid;
    const banks = await deps.pouchLiquifiaClient.listBanks();
    const bank = (banks ?? []).find((b) =>
      String((b as { name?: string }).name ?? '').toLowerCase().includes(TREASURY_BANK_QUERY),
    ) as { uuid?: string; id?: string; name?: string } | undefined;
    if (!bank) {
      console.error('[treasury-sweep] treasury bank not found in Pouch bank list', {
        query: TREASURY_BANK_QUERY,
      });
      return null;
    }
    const uuid = bank.uuid ?? bank.id ?? null;
    if (!uuid) return null;
    // The destination must resolve to a real account NAME before any money
    // moves toward it — a typo'd account number must fail loudly here.
    const validated = await deps.pouchLiquifiaClient
      .validateBankAccount({ accountNumber: TREASURY_ACCOUNT_NUMBER, bankUuid: uuid })
      .catch(() => null);
    const accountName = (validated as { account_name?: string } | null)?.account_name;
    if (!accountName) {
      console.error('[treasury-sweep] treasury account did not validate — refusing to sweep', {
        account: TREASURY_ACCOUNT_NUMBER,
      });
      return null;
    }
    console.info('[treasury-sweep] destination verified', {
      account: TREASURY_ACCOUNT_NUMBER,
      bank: bank.name,
      accountName,
    });
    destinationBankUuid = uuid;
    return uuid;
  };

  const sweepOnce = async (): Promise<void> => {
    if (running) return; // a slow provider must not stack sweeps
    running = true;
    try {
      const bankUuid = await resolveDestination();
      if (!bankUuid) return;

      const accounts = await prisma.virtualAccount.findMany({
        include: { user: { select: { privyDid: true } } },
      });

      let sweptNgn = 0;
      let sweptCount = 0;
      for (const account of accounts) {
        if (account.user.privyDid?.startsWith('seed:')) continue;
        if (account.pouchVirtualAccountId === treasuryVaId) continue;

        let balanceNgn = 0;
        try {
          const balance = await deps.pouchLiquifiaClient.getVirtualAccountBalance(
            account.pouchVirtualAccountId,
          );
          balanceNgn = Number(balance.balance ?? 0) / 100; // Pouch reports kobo
        } catch {
          continue; // unreadable balance: skip this round, try next interval
        }
        if (balanceNgn < Math.max(SWEEP_MIN_NGN, POUCH_PAYOUT_FEE_NGN + 1)) continue;

        // Pouch's payout fee is tiered (₦20 has been seen, so has ₦70) and
        // undocumented per amount — so sweep, and when the provider answers
        // "Available: X, Required: Y", learn the true headroom from the
        // deficit and retry once with exactly that much less.
        let amountNgn = Math.floor(balanceNgn - POUCH_PAYOUT_FEE_NGN);
        for (let attempt = 0; attempt < 2 && amountNgn > 0; attempt += 1) {
          try {
            const payout = await deps.pouchLiquifiaClient.createPayout({
              virtualAccountId: account.pouchVirtualAccountId,
              amount: amountNgn,
              destinationAccount: TREASURY_ACCOUNT_NUMBER,
              destinationBankUuid: bankUuid,
              narration: 'Wheelers treasury float sweep',
              idempotencyKey: `sweep-${account.pouchVirtualAccountId}-${Date.now()}-${attempt}`,
            });
            const status = String(payout.status ?? '').toUpperCase();
            if (status.includes('FAIL') || status.includes('REJECT')) {
              console.warn('[treasury-sweep] sweep payout rejected', {
                va: account.accountNumber,
                amountNgn,
                status: payout.status,
              });
              break;
            }
            sweptNgn += amountNgn;
            sweptCount += 1;
            console.info('[treasury-sweep] swept', {
              va: account.accountNumber,
              amountNgn,
              status: payout.status,
            });
            break;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const short = message.match(/Available:\s*([\d.]+)\s*NGN.*Required:\s*([\d.]+)\s*NGN/i);
            if (short && attempt === 0) {
              const deficit = Math.ceil(Number(short[2]) - Number(short[1]));
              if (Number.isFinite(deficit) && deficit > 0 && deficit < amountNgn) {
                amountNgn -= deficit;
                continue; // retry once with the provider's own arithmetic
              }
            }
            console.warn('[treasury-sweep] sweep payout failed', {
              va: account.accountNumber,
              amountNgn,
              error: message.slice(0, 200),
            });
            break;
          }
        }
      }

      // The solvency line an operator can grep for: float after this pass.
      const treasury = await deps.pouchLiquifiaClient
        .getVirtualAccountBalance(treasuryVaId)
        .catch(() => null);
      console.info('[treasury-sweep] pass complete', {
        sweptCount,
        sweptNgn,
        treasuryFloatNgn: treasury ? Number(treasury.balance ?? 0) / 100 : 'unreadable',
      });
    } finally {
      running = false;
    }
  };

  // First pass shortly after boot (deposits may have piled up while down),
  // then steadily. unref: the sweep must never keep a dying process alive.
  setTimeout(() => void sweepOnce(), 15_000).unref();
  const timer = setInterval(() => void sweepOnce(), SWEEP_INTERVAL_MS);
  timer.unref();
  console.info('[treasury-sweep] started', {
    intervalMs: SWEEP_INTERVAL_MS,
    minSweepNgn: SWEEP_MIN_NGN,
  });
}
