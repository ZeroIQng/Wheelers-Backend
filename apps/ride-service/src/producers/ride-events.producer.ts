import type { WheelersProducer } from '@wheleers/kafka-client';
import { TOPICS, type RideDriverAssignedEvent, type GpsStaleWarningEvent } from '@wheleers/kafka-schemas';

export type RideEventsProducer = {
  rideDriverAssigned(event: RideDriverAssignedEvent): Promise<void>;
  gpsStaleWarning(event: GpsStaleWarningEvent): Promise<void>;
};

export function createRideEventsProducer(producer: WheelersProducer): RideEventsProducer {
  return {
    async rideDriverAssigned(event) {
      await producer.send(TOPICS.RIDE_EVENTS, event as any, { key: event.rideId });
    },

    async gpsStaleWarning(event) {
      await producer.send(TOPICS.COMPLIANCE_EVENTS, event as any, { key: event.rideId });
    },
  };
}

