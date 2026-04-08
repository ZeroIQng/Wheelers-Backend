import { rideClient } from '@wheleers/db';
import type { MessageContext } from '@wheleers/kafka-client';
import { safeParseKafkaEvent, TOPICS } from '@wheleers/kafka-schemas';

export type TripLifecycleHandler = {
  handleRideEvent(value: unknown, ctx: MessageContext): Promise<void>;
};

export function createTripLifecycleHandler(): TripLifecycleHandler {
  return {
    async handleRideEvent(value, ctx) {
      if (ctx.topic !== TOPICS.RIDE_EVENTS) return;
      const event = safeParseKafkaEvent(TOPICS.RIDE_EVENTS, value);
      if (!event) return;

      if (event.eventType === 'RIDE_STARTED') {
        try {
          await rideClient.start(event.rideId, event.recordingId);
        } catch (err) {
          console.warn(`[ride-service] ride start skipped:`, (err as any)?.message ?? err);
        }
      }

      if (event.eventType === 'RIDE_CANCELLED') {
        try {
          await rideClient.cancel(event.rideId, {
            cancelStage: stageToDb(event.cancelStage),
            cancelReason: event.reason,
            penaltyUsdt: event.penaltyUsdt,
          });
        } catch (err) {
          console.warn(`[ride-service] ride cancel skipped:`, (err as any)?.message ?? err);
        }
      }
    },
  };
}

function stageToDb(stage: string): any {
  switch (stage) {
    case 'before_match':
      return 'BEFORE_MATCH';
    case 'after_match':
      return 'AFTER_MATCH';
    case 'driver_en_route':
      return 'DRIVER_EN_ROUTE';
    case 'active_trip':
      return 'ACTIVE_TRIP';
    default:
      return 'BEFORE_MATCH';
  }
}
