import { validateRideEnv, validateSharedEnv } from '@wheleers/config';
import { rideClient } from '@wheleers/db';
import { createConsumer, createProducer } from '@wheleers/kafka-client';
import { safeParseKafkaEvent, TOPICS } from '@wheleers/kafka-schemas';

type OnlineDriver = {
  driverId: string;
  walletAddress: string;
  lat: number;
  lng: number;
  vehiclePlate: string;
  vehicleModel: string;
};

const SERVICE_ID = 'ride-service';

bootstrap().catch((err) => {
  console.error(`[${SERVICE_ID}] fatal`, err);
  process.exit(1);
});

async function bootstrap(): Promise<void> {
  process.env['NODE_ENV'] ??= 'development';
  process.env['KAFKA_CLIENT_ID'] ??= SERVICE_ID;
  process.env['KAFKA_BROKERS'] ??= 'localhost:9092';
  process.env['DATABASE_URL'] ??= 'postgresql://postgres:postgres@localhost:5432/wheelers';
  process.env['REDIS_URL'] ??= 'redis://localhost:6379';

  validateSharedEnv();
  validateRideEnv();

  const producer = await createProducer({ serviceId: SERVICE_ID });
  const consumer = await createConsumer({ groupId: SERVICE_ID });

  const onlineDrivers = new Map<string, OnlineDriver>();

  await consumer.subscribe(
    [TOPICS.DRIVER_EVENTS, TOPICS.RIDE_EVENTS],
    async (value, ctx) => {
      if (ctx.topic === TOPICS.DRIVER_EVENTS) {
        const event = safeParseKafkaEvent(TOPICS.DRIVER_EVENTS, value);
        if (!event) return;

        if (event.eventType === 'DRIVER_ONLINE') {
          onlineDrivers.set(event.driverId, {
            driverId: event.driverId,
            walletAddress: event.walletAddress,
            lat: event.lat,
            lng: event.lng,
            vehiclePlate: event.vehiclePlate,
            vehicleModel: event.vehicleModel,
          });
        }

        if (event.eventType === 'DRIVER_OFFLINE') {
          onlineDrivers.delete(event.driverId);
        }

        return;
      }

      if (ctx.topic === TOPICS.RIDE_EVENTS) {
        const event = safeParseKafkaEvent(TOPICS.RIDE_EVENTS, value);
        if (!event) return;

        if (event.eventType === 'RIDE_REQUESTED') {
          // Persist the ride (best effort)
          try {
            await rideClient.create({
              id: event.rideId,
              riderId: event.riderId,
              pickupLat: event.pickup.lat,
              pickupLng: event.pickup.lng,
              pickupAddress: event.pickup.address,
              destLat: event.destination.lat,
              destLng: event.destination.lng,
              destAddress: event.destination.address,
              fareEstimateUsdt: event.fareEstimateUsdt,
            });
          } catch (err) {
            console.warn(`[${SERVICE_ID}] ride create skipped:`, (err as any)?.message ?? err);
          }

          const driver = pickAnyDriver(onlineDrivers);
          if (!driver) {
            console.log(`[${SERVICE_ID}] no drivers online for ride ${event.rideId}`);
            return;
          }

          const assigned = {
            eventType: 'RIDE_DRIVER_ASSIGNED',
            rideId: event.rideId,
            riderId: event.riderId,
            driverId: driver.driverId,
            driverWallet: driver.walletAddress,
            driverName: 'Driver',
            driverRating: 5,
            vehiclePlate: driver.vehiclePlate,
            vehicleModel: driver.vehicleModel,
            etaSeconds: 120,
            lockedFareUsdt: event.fareEstimateUsdt,
            timestamp: new Date().toISOString(),
          } as const;

          await producer.send(TOPICS.RIDE_EVENTS, assigned as any, { key: event.rideId });
          console.log(`[${SERVICE_ID}] assigned ride ${event.rideId} -> driver ${driver.driverId}`);
        }

        if (event.eventType === 'RIDE_STARTED') {
          try {
            await rideClient.start(event.rideId, event.recordingId);
          } catch (err) {
            console.warn(`[${SERVICE_ID}] ride start skipped:`, (err as any)?.message ?? err);
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
            console.warn(`[${SERVICE_ID}] ride cancel skipped:`, (err as any)?.message ?? err);
          }
        }
      }
    },
  );

  console.log(`[${SERVICE_ID}] consuming`);
}

function pickAnyDriver(map: Map<string, OnlineDriver>): OnlineDriver | null {
  const first = map.values().next();
  return first.done ? null : first.value;
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
