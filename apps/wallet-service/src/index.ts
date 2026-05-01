import { loadWorkspaceEnv, validateSharedEnv, validateWalletEnv } from '@wheleers/config';
import { walletClient } from '@wheleers/db';
import { createConsumer, createProducer } from '@wheleers/kafka-client';
import { TOPICS } from '@wheleers/kafka-schemas';

import { createDefiEventsProducer } from './producers/defi-events.producer';
import { createWalletEventsProducer } from './producers/wallet-events.producer';
import { createDefiEventsConsumer } from './consumers/defi-events.consumer';
import { createPaymentEventsConsumer } from './consumers/payment-events.consumer';
import { createRideEventsConsumer } from './consumers/ride-events.consumer';
import { createUserEventsConsumer } from './consumers/user-events.consumer';

const SERVICE_ID = 'wallet-service';

bootstrap().catch((err) => {
  console.error(`[${SERVICE_ID}] fatal`, err);
  process.exit(1);
});

async function bootstrap(): Promise<void> {
  loadWorkspaceEnv();
  process.env['NODE_ENV'] ??= 'development';
  process.env['KAFKA_CLIENT_ID'] ??= SERVICE_ID;
  process.env['KAFKA_BROKERS'] ??= 'localhost:9092';
  process.env['DATABASE_URL'] ??= 'postgresql://postgres:postgres@localhost:5432/wheelers';
  process.env['REDIS_URL'] ??= 'redis://localhost:6379';

  process.env['PLATFORM_PRIVATE_KEY'] ??= 'dev';
  process.env['RPC_URL_BASE'] ??= 'http://localhost:8545';

  validateSharedEnv();
  validateWalletEnv();

  const producer = await createProducer({ serviceId: SERVICE_ID });
  const consumer = await createConsumer({ groupId: SERVICE_ID });

  const walletEventsProducer = createWalletEventsProducer(producer);
  const defiEventsProducer = createDefiEventsProducer(producer);

  const userEventsConsumer = createUserEventsConsumer({
    walletRepository: walletClient,
  });
  const rideEventsConsumer = createRideEventsConsumer({
    walletRepository: walletClient,
    walletEventsProducer,
    serviceId: SERVICE_ID,
  });
  const paymentEventsConsumer = createPaymentEventsConsumer({
    walletRepository: walletClient,
    walletEventsProducer,
    serviceId: SERVICE_ID,
  });
  const defiEventsConsumer = createDefiEventsConsumer({
    walletRepository: walletClient,
    defiEventsProducer,
    serviceId: SERVICE_ID,
  });

  await consumer.subscribe(
    [TOPICS.USER_EVENTS, TOPICS.RIDE_EVENTS, TOPICS.PAYMENT_EVENTS, TOPICS.DEFI_EVENTS],
    async (value, ctx) => {
      if (ctx.topic === TOPICS.USER_EVENTS) {
        await userEventsConsumer.handle(value, ctx);
        return;
      }

      if (ctx.topic === TOPICS.RIDE_EVENTS) {
        await rideEventsConsumer.handle(value, ctx);
        return;
      }

      if (ctx.topic === TOPICS.PAYMENT_EVENTS) {
        await paymentEventsConsumer.handle(value, ctx);
        return;
      }

      if (ctx.topic === TOPICS.DEFI_EVENTS) {
        await defiEventsConsumer.handle(value, ctx);
      }
    },
  );

  console.log(`[${SERVICE_ID}] consuming`);
}
