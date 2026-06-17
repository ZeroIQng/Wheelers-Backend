import type { WheelersProducer } from '@wheleers/kafka-client';
import {
  TOPICS,
  type GroupRideCandidatesIdentifiedEvent,
  type GroupRideDriverDispatchRequestedEvent,
  type GroupRidePlannedEvent,
  type GroupRideRouteBuiltEvent,
  type GroupRideEvent,
} from '@wheleers/kafka-schemas';

export type GroupRideEventsProducer = {
  candidatesIdentified(event: GroupRideCandidatesIdentifiedEvent): Promise<void>;
  groupPlanned(event: GroupRidePlannedEvent): Promise<void>;
  routeBuilt(event: GroupRideRouteBuiltEvent): Promise<void>;
  driverDispatchRequested(event: GroupRideDriverDispatchRequestedEvent): Promise<void>;
  /** Generic publish for any group ride event that has a groupId. */
  publish(event: Extract<GroupRideEvent, { groupId: string }>): Promise<void>;
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

    async driverDispatchRequested(event) {
      await producer.send(TOPICS.GROUP_RIDE_EVENTS, event as any, {
        key: event.groupId,
      });
    },

    async publish(event) {
      await producer.send(TOPICS.GROUP_RIDE_EVENTS, event as any, {
        key: event.groupId,
      });
    },
  };
}
