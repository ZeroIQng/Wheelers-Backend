import type { PaymentSessionSyncedEvent } from '@wheleers/kafka-schemas';
import type { PaymentEventsProducer } from '../producers/payment-events.producer';
import { processPaymentSessionSync } from '../services/settlement.service';

interface PaymentEventsHandlerDeps {
  paymentEventsProducer: PaymentEventsProducer;
}

export function createPaymentEventsHandler(deps: PaymentEventsHandlerDeps) {
  return {
    async handlePaymentSessionSynced(event: PaymentSessionSyncedEvent): Promise<void> {
      await processPaymentSessionSync(event, deps.paymentEventsProducer);
    },
  };
}

export type PaymentEventsHandler = ReturnType<typeof createPaymentEventsHandler>;
