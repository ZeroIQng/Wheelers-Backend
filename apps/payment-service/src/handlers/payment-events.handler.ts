import type {
  PaymentSessionCreatedEvent,
  PaymentSessionSyncedEvent,
} from '@wheleers/kafka-schemas';
import type { PaymentEventsProducer } from '../producers/payment-events.producer';
import { recordPaymentIntent } from '../services/payment-intents.service';
import { processPaymentSessionSync } from '../services/settlement.service';

interface PaymentEventsHandlerDeps {
  paymentEventsProducer: PaymentEventsProducer;
}

export function createPaymentEventsHandler(deps: PaymentEventsHandlerDeps) {
  return {
    async handlePaymentSessionCreated(event: PaymentSessionCreatedEvent): Promise<void> {
      await recordPaymentIntent(event);
    },

    async handlePaymentSessionSynced(event: PaymentSessionSyncedEvent): Promise<void> {
      await recordPaymentIntent(event);
      await processPaymentSessionSync(event, deps.paymentEventsProducer);
    },
  };
}

export type PaymentEventsHandler = ReturnType<typeof createPaymentEventsHandler>;
