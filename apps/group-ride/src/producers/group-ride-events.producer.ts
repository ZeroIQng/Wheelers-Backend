import type { WheelersProducer } from '@wheleers/kafka-client';
import {
  TOPICS,
  type GroupRideCandidatesIdentifiedEvent,
  type GroupRidePlannedEvent,
  type GroupRideRouteBuiltEvent,
} from '@wheleers/kafka-schemas';

export type GroupRideEventsProducer = {
  candidatesIdentified(event: GroupRideCandidatesIdentifiedEvent): Promise<void>;
  groupPlanned(event: GroupRidePlannedEvent): Promise<void>;
  routeBuilt(event: GroupRideRouteBuiltEvent): Promise<void>;
};

export function createGroupRideEventsProducer(
  producer: WheelersProducer,
): GroupRideEventsProducer {
  return {
    async candidatesIdentified(event) {
      await producer.send(TOPICS.GROUP_RIDE_EVENTS, event as any, {
        key: event.groupId,
      });
    },

    async groupPlanned(event) {
      await producer.send(TOPICS.GROUP_RIDE_EVENTS, event as any, {
        key: event.groupId,
      });
    },

    async routeBuilt(event) {
      await producer.send(TOPICS.GROUP_RIDE_EVENTS, event as any, {
        key: event.groupId,
      });
    },
  };
}
