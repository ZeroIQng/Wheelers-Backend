import {
  buildTopicList,
  createConsumer,
  createProducer,
  ensureTopics,
  onShutdown,
  TOPIC_PRESETS,
} from '@wheleers/kafka-client';
import {
  GoogleMapsRoutePlanner,
  loadWorkspaceEnv,
  validateGroupRideEnv,
  validateSharedEnv,
} from '@wheleers/config';
import {
  safeParseKafkaEvent,
  TOPICS,
} from '@wheleers/kafka-schemas';

import { createGroupRidePlanner } from './planner/group-ride.planner';
import { createGroupRideEventsProducer } from './producers/group-ride-events.producer';
import { createGroupRideState } from './state';

const SERVICE_ID = 'group-ride';

bootstrap().catch((err) => {
  console.error(`[${SERVICE_ID}] fatal`, err);
  process.exit(1);
});

async function bootstrap(): Promise<void> {
  loadWorkspaceEnv();

  process.env['NODE_ENV'] ??= 'development';
  process.env['KAFKA_CLIENT_ID'] ??= SERVICE_ID;
  process.env['KAFKA_BROKERS'] ??= 'localhost:29092';
  process.env['DATABASE_URL'] ??= 'postgresql://postgres:postgres@localhost:5432/wheelers';
  process.env['REDIS_URL'] ??= 'redis://localhost:6379';

  validateSharedEnv();
  const groupRideEnv = validateGroupRideEnv();

  await ensureTopics(
    buildTopicList([[TOPICS.GROUP_RIDE_EVENTS, TOPIC_PRESETS.LOW_VOLUME]]),
  );

  const producer = await createProducer({ serviceId: SERVICE_ID });
  const consumer = await createConsumer({ groupId: SERVICE_ID });
  const routePlanner = new GoogleMapsRoutePlanner(
    groupRideEnv.GOOGLE_MAPS_BASE_URL,
    groupRideEnv.GOOGLE_MAPS_API_KEY,
  );

  const planner = createGroupRidePlanner({
    env: groupRideEnv,
    routePlanner,
    groupRideEventsProducer: createGroupRideEventsProducer(producer),
    state: createGroupRideState(),
  });

  await consumer.subscribe(
    [TOPICS.RIDE_EVENTS, TOPICS.GROUP_RIDE_EVENTS],
    async (value, ctx) => {
      if (ctx.topic === TOPICS.RIDE_EVENTS) {
        const event = safeParseKafkaEvent(TOPICS.RIDE_EVENTS, value);
        if (!event) {
          return;
        }

        if (event.eventType === 'RIDE_REQUESTED') {
          await planner.handleRideRequested(event);
          return;
        }

        if (
          event.eventType === 'RIDE_CANCELLED' ||
          event.eventType === 'RIDE_COMPLETED'
        ) {
          planner.releaseRide(event.rideId);
        }

        return;
      }

      const event = safeParseKafkaEvent(TOPICS.GROUP_RIDE_EVENTS, value);
      if (!event) {
        return;
      }

      await planner.handleGroupRideEvent(event);
    },
  );

  onShutdown(async () => {
    await consumer.disconnect();
    await producer.disconnect();
  });

  console.log(
    `[${SERVICE_ID}] consuming ` +
      `(pickupRadiusKm=${groupRideEnv.GROUP_RIDE_PICKUP_RADIUS_KM}, ` +
      `destinationRadiusKm=${groupRideEnv.GROUP_RIDE_DESTINATION_RADIUS_KM}, ` +
      `maxGroupSize=${groupRideEnv.GROUP_RIDE_MAX_SIZE})`,
  );
}
