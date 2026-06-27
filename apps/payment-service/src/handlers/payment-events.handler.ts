import { withdrawalClient } from '@wheleers/db';
import type { PouchLiquifiaClient } from '@wheleers/pouch-client';
import type {
  VirtualAccountCreditedEvent,
  PayoutCreatedEvent,
  PayoutCompletedEvent,
  PayoutFailedEvent,
} from '@wheleers/kafka-schemas';

const TAG = '[payment-events-handler]';

export interface PaymentEventsHandlerDeps {
  pouchClient: PouchLiquifiaClient;
  serviceId?: string;
}

export function createPaymentEventsHandler(deps: PaymentEventsHandlerDeps) {
  const { pouchClient, serviceId = 'payment-service' } = deps;

  return {
    /**
     * Deposit received via bank transfer.
     * The actual wallet credit is handled by wallet-service — here we just
     * log for audit and could trigger fraud checks in the future.
     */
    async handleVirtualAccountCredited(event: VirtualAccountCreditedEvent): Promise<void> {
      console.log(
        `${TAG} DEPOSIT userId=${event.userId} amount=NGN${event.amountNgn} ` +
        `ref=${event.providerReference} va=${event.pouchVirtualAccountId}`,
      );

      if (event.bankName) {
        console.log(
          `${TAG} deposit source: ${event.senderAccountName ?? 'unknown'} ` +
          `(${event.senderAccountNumber ?? 'N/A'}) via ${event.bankName}`,
        );
      }
    },

    /**
     * Payout created — verify with Pouch that the payout is in a valid state.
     * If Pouch returns PROCESSING/PENDING, mark it accordingly.
     * If it already shows as completed/failed (rare race), settle immediately.
     */
    async handlePayoutCreated(event: PayoutCreatedEvent): Promise<void> {
      console.log(
        `${TAG} PAYOUT_CREATED userId=${event.userId} ` +
        `payoutId=${event.pouchPayoutId} withdrawal=${event.withdrawalId} ` +
        `amount=NGN${event.amountNgn} → ${event.bankAccountName} (${event.bankAccountNumber})`,
      );

      try {
        const payout = await pouchClient.getPayout(event.pouchPayoutId);
        const status = (payout.status ?? '').toUpperCase();

        console.log(
          `${TAG} payout ${event.pouchPayoutId} provider status: ${status}`,
        );

        // Sync local state with Pouch's current status
        if (status === 'PROCESSING' || status === 'PENDING') {
          await withdrawalClient.markProcessing(payout.reference);
        } else if (status === 'SUCCESSFUL' || status === 'COMPLETED') {
          // Race condition: payout settled before event processed
          await withdrawalClient.settle(payout.reference);
          console.warn(
            `${TAG} payout ${event.pouchPayoutId} already settled — synced`,
          );
        } else if (status === 'FAILED' || status === 'REVERSED' || status === 'CANCELLED') {
          await withdrawalClient.releaseFailedRequest({
            providerReference: payout.reference,
            failureReason: `Payout ${status.toLowerCase()} (detected at creation)`,
            status: 'FAILED',
          });
          console.warn(
            `${TAG} payout ${event.pouchPayoutId} already ${status.toLowerCase()} — released`,
          );
        }
      } catch (error) {
        // Non-critical — webhook will handle final state
        console.warn(
          `${TAG} could not verify payout ${event.pouchPayoutId}:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    },

    /**
     * Payout completed — log for audit. The webhook handler has already
     * settled the withdrawal and updated the wallet.
     */
    async handlePayoutCompleted(event: PayoutCompletedEvent): Promise<void> {
      console.log(
        `${TAG} PAYOUT_COMPLETED userId=${event.userId} ` +
        `payoutId=${event.pouchPayoutId} amount=NGN${event.amountNgn} ` +
        `ref=${event.providerReference}`,
      );
    },

    /**
     * Payout failed — log for audit. The webhook handler has already
     * released the reserved funds.
     */
    async handlePayoutFailed(event: PayoutFailedEvent): Promise<void> {
      console.error(
        `${TAG} PAYOUT_FAILED userId=${event.userId} ` +
        `payoutId=${event.pouchPayoutId} reason=${event.failureReason} ` +
        `ref=${event.providerReference}`,
      );
    },
  };
}

export type PaymentEventsHandler = ReturnType<typeof createPaymentEventsHandler>;
