import type { WheelersProducer } from '@wheleers/kafka-client';
import { TOPICS, type DefiStakedEvent } from '@wheleers/kafka-schemas';

type PublishOptions = {
  key: string;
};

export interface DefiEventsProducer {
  publishStaked(
    payload: Omit<DefiStakedEvent, 'eventType' | 'timestamp'>,
    options: PublishOptions,
  ): Promise<void>;
}

export function createDefiEventsProducer(producer: WheelersProducer): DefiEventsProducer {
  return {
    async publishStaked(payload, options) {
      await producer.send(TOPICS.DEFI_EVENTS, {
        eventType: 'DEFI_STAKED',
        ...payload,
        timestamp: new Date().toISOString(),
      }, { key: options.key });
    },
  };
}
