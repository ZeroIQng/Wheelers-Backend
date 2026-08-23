import { withdrawalClient } from '@wheleers/db';
import { classifyPouchPayoutStatus } from '@wheleers/pouch-client';
import type { PouchLiquifiaClient } from '@wheleers/pouch-client';

const TAG = '[payout-reconciliation]';

const SWEEP_INTERVAL_MS = Number(process.env['PAYOUT_RECONCILE_INTERVAL_MS'] ?? 5 * 60 * 1000);
const STALE_AFTER_MS = Number(process.env['PAYOUT_RECONCILE_STALE_MS'] ?? 10 * 60 * 1000);

/**
 * Webhooks get lost — a payout.failed that arrives before attachPayout, a
 * provider retry dropped by dedup, an outage. Every lost webhook strands a
 * withdrawal in PAYOUT_CREATED/PROCESSING with the rider's money locked.
 * This sweep re-checks quiet in-flight payouts against Pouch and settles or
 * refunds them.
 */
export function startPayoutReconciliation(pouchClient: PouchLiquifiaClient): () => void {
  let running = false;

  const sweep = async () => {
    if (running) return;
    running = true;
    try {
      const stale = await withdrawalClient.findStaleInFlight(
        new Date(Date.now() - STALE_AFTER_MS),
      );
      if (stale.length > 0) {
        console.log(`${TAG} checking ${stale.length} stale in-flight withdrawal(s)`);
      }

      for (const request of stale) {
        if (!request.pouchPayoutId || !request.providerReference) continue;
        try {
          const payout = await pouchClient.getPayout(request.pouchPayoutId);
          const outcome = classifyPouchPayoutStatus(payout.status);

          if (outcome === 'settled') {
            await withdrawalClient.settle(request.providerReference);
            console.log(`${TAG} settled ${request.id} (provider: ${payout.status})`);
          } else if (outcome === 'failed') {
            await withdrawalClient.releaseFailedRequest({
              providerReference: request.providerReference,
              failureReason: `Payout ${(payout.status ?? 'failed').toLowerCase()} (reconciliation)`,
              status: 'FAILED',
            });
            console.warn(`${TAG} refunded ${request.id} (provider: ${payout.status})`);
          } else {
            await withdrawalClient.markProcessing(request.providerReference);
          }
        } catch (error) {
          console.warn(`${TAG} could not reconcile ${request.id}:`, error instanceof Error ? error.message : String(error));
        }
      }
    } catch (error) {
      console.error(`${TAG} sweep failed:`, error instanceof Error ? error.message : String(error));
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void sweep(), SWEEP_INTERVAL_MS);
  timer.unref?.();
  void sweep();

  return () => clearInterval(timer);
}
