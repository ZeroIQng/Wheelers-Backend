import type { WheelersProducer } from '@wheleers/kafka-client';
import { TOPICS, type GpsProcessedEvent } from '@wheleers/kafka-schemas';

export type GpsProcessedProducer = {
  gpsProcessed(event: GpsProcessedEvent): Promise<void>;
};

export function createGpsProcessedProducer(producer: WheelersProducer): GpsProcessedProducer {
  return {
    async gpsProcessed(event) {
      await producer.send(TOPICS.GPS_PROCESSED, event as any, { key: event.driverId });
    },
  };
}

