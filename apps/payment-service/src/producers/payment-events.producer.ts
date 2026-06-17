import type { WheelersProducer } from '@wheleers/kafka-client';
import {
  TOPICS,
  type PayoutCreatedEvent,
  type PayoutCompletedEvent,
  type PayoutFailedEvent,
  type VirtualAccountCreditedEvent,
} from '@wheleers/kafka-schemas';

export function createPaymentEventsProducer(producer: WheelersProducer) {
  return {
    async publishVirtualAccountCredited(event: VirtualAccountCreditedEvent): Promise<void> {
      await producer.send(TOPICS.PAYMENT_EVENTS, event, { key: event.userId });
    },

    async publishPayoutCreated(event: PayoutCreatedEvent): Promise<void> {
      await producer.send(TOPICS.PAYMENT_EVENTS, event, { key: event.userId });
    },

    async publishPayoutCompleted(event: PayoutCompletedEvent): Promise<void> {
      await producer.send(TOPICS.PAYMENT_EVENTS, event, { key: event.userId });
    },

    async publishPayoutFailed(event: PayoutFailedEvent): Promise<void> {
      await producer.send(TOPICS.PAYMENT_EVENTS, event, { key: event.userId });
    },
  };
}

export type PaymentEventsProducer = ReturnType<typeof createPaymentEventsProducer>;
