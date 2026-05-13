import type { WheelersProducer } from '@wheleers/kafka-client';
import {
  TOPICS,
  type OnrampSettledEvent,
} from '@wheleers/kafka-schemas';

export function createPaymentEventsProducer(producer: WheelersProducer) {
  return {
    async publishOnrampSettled(event: OnrampSettledEvent): Promise<void> {
      await producer.send(TOPICS.PAYMENT_EVENTS, event, { key: event.userId });
    },
  };
}

export type PaymentEventsProducer = ReturnType<typeof createPaymentEventsProducer>;
