import type {
  VirtualAccountCreditedEvent,
  PayoutCreatedEvent,
  PayoutCompletedEvent,
  PayoutFailedEvent,
} from '@wheleers/kafka-schemas';

const TAG = '[payment-events-handler]';

export function createPaymentEventsHandler() {
  return {
    async handleVirtualAccountCredited(event: VirtualAccountCreditedEvent): Promise<void> {
      console.log(
        `${TAG} VIRTUAL_ACCOUNT_CREDITED userId=${event.userId} amount=${event.amountNgn} ref=${event.providerReference}`,
      );
    },

    async handlePayoutCreated(event: PayoutCreatedEvent): Promise<void> {
      console.log(
        `${TAG} PAYOUT_CREATED userId=${event.userId} payoutId=${event.pouchPayoutId} amount=${event.amountNgn}`,
      );
    },

    async handlePayoutCompleted(event: PayoutCompletedEvent): Promise<void> {
      console.log(
        `${TAG} PAYOUT_COMPLETED userId=${event.userId} payoutId=${event.pouchPayoutId} amount=${event.amountNgn}`,
      );
    },

    async handlePayoutFailed(event: PayoutFailedEvent): Promise<void> {
      console.log(
        `${TAG} PAYOUT_FAILED userId=${event.userId} payoutId=${event.pouchPayoutId} reason=${event.failureReason}`,
      );
    },
  };
}

export type PaymentEventsHandler = ReturnType<typeof createPaymentEventsHandler>;
