/**
 * Withdrawal limits.
 *
 * The payout provider (Pouch Liquifia) rejects transfers below NGN 5,000.
 * Enforcing it here means we fail fast with a clear message instead of
 * reserving the user's funds, calling out to the provider, getting an opaque
 * rejection, and then having to release the reservation again.
 *
 * Override with WITHDRAWAL_MIN_NGN if the provider floor ever changes.
 */
const DEFAULT_MIN_WITHDRAWAL_NGN = 5000;

function readMinWithdrawalNgn(): number {
  const raw = process.env.WITHDRAWAL_MIN_NGN;
  if (!raw) return DEFAULT_MIN_WITHDRAWAL_NGN;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.warn(
      '[config] WITHDRAWAL_MIN_NGN is not a valid non-negative number, falling back to default',
      { value: raw, fallbackNgn: DEFAULT_MIN_WITHDRAWAL_NGN },
    );
    return DEFAULT_MIN_WITHDRAWAL_NGN;
  }

  return parsed;
}

export const MIN_WITHDRAWAL_NGN = readMinWithdrawalNgn();

/**
 * Flat fee Pouch charges per payout, taken from the virtual account on top
 * of the transfer amount. Confirmed empirically: a payout of N requires
 * N + 20 available ("Required: 715020" for a 715000 request).
 */
export const POUCH_PAYOUT_FEE_NGN = Number(process.env.POUCH_PAYOUT_FEE_NGN ?? 20);
