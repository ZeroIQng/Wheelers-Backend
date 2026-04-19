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

      if (event.eventType === 'ONRAMP_SETTLED') {
        await deps.paymentEventsHandler.handleOnrampSettled(event);
      }
    },
  };
}
