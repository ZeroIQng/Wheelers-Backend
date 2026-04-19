import type { MessageContext } from '@wheleers/kafka-client';
import { safeParseKafkaEvent, TOPICS } from '@wheleers/kafka-schemas';
import type { RideEventsHandler } from '../handlers/ride-events.handler';

interface RideEventsConsumerDeps {
  rideEventsHandler: RideEventsHandler;
}

export function createRideEventsConsumer(deps: RideEventsConsumerDeps) {
  return {
    async handle(value: unknown, _ctx: MessageContext): Promise<void> {
      const event = safeParseKafkaEvent(TOPICS.RIDE_EVENTS, value);
      if (!event) return;

      if (event.eventType === 'RIDE_COMPLETED') {
        await deps.rideEventsHandler.handleRideCompleted(event);
        return;
      }

      if (event.eventType === 'RIDE_CANCELLED') {
        await deps.rideEventsHandler.handleRideCancelled(event);
      }
    },
  };
}
