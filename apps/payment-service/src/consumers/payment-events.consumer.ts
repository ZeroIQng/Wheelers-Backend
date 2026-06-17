import type { MessageContext } from '@wheleers/kafka-client';
import { safeParseKafkaEvent, TOPICS } from '@wheleers/kafka-schemas';
import type { PaymentEventsHandler } from '../handlers/payment-events.handler';

interface PaymentEventsConsumerDeps {
  paymentEventsHandler: PaymentEventsHandler;
}

export function createPaymentEventsConsumer(deps: PaymentEventsConsumerDeps) {
  return {
    async handle(value: unknown, _ctx: MessageContext): Promise<void> {
      const event = safeParseKafkaEvent(TOPICS.PAYMENT_EVENTS, value);
      if (!event) return;

      switch (event.eventType) {
        case 'VIRTUAL_ACCOUNT_CREDITED':
          await deps.paymentEventsHandler.handleVirtualAccountCredited(event);
          break;
        case 'PAYOUT_CREATED':
          await deps.paymentEventsHandler.handlePayoutCreated(event);
          break;
        case 'PAYOUT_COMPLETED':
          await deps.paymentEventsHandler.handlePayoutCompleted(event);
          break;
        case 'PAYOUT_FAILED':
          await deps.paymentEventsHandler.handlePayoutFailed(event);
          break;
      }
    },
  };
}
