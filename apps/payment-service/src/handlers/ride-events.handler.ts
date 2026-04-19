import type { RideCancelledEvent, RideCompletedEvent } from '@wheleers/kafka-schemas';
import type { PaymentEventsProducer } from '../producers/payment-events.producer';

interface RideEventsHandlerDeps {
  paymentEventsProducer: PaymentEventsProducer;
}

export function createRideEventsHandler(deps: RideEventsHandlerDeps) {
  return {
    async handleRideCompleted(event: RideCompletedEvent): Promise<void> {
      await deps.paymentEventsProducer.publishDriverPayout(event);
    },

    async handleRideCancelled(event: RideCancelledEvent): Promise<void> {
      await deps.paymentEventsProducer.publishPenalty(event);
    },
  };
}

export type RideEventsHandler = ReturnType<typeof createRideEventsHandler>;
