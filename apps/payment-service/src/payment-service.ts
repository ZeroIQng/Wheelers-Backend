import { validatePaymentEnv, validateSharedEnv } from '@wheleers/config';
import {
  createConsumer,
  createProducer,
  onShutdown,
  registerShutdownHandlers,
} from '@wheleers/kafka-client';
import { TOPICS } from '@wheleers/kafka-schemas';
import { createPaymentEventsConsumer } from './consumers/payment-events.consumer';
import { createRideEventsConsumer } from './consumers/ride-events.consumer';
import { applyPaymentServiceDefaults, getPaymentServiceId } from './config/runtime';
import { createPaymentEventsHandler } from './handlers/payment-events.handler';
import { createRideEventsHandler } from './handlers/ride-events.handler';
import { createPaymentEventsProducer } from './producers/payment-events.producer';

export async function startPaymentService(): Promise<void> {
  applyPaymentServiceDefaults();

  const serviceId = getPaymentServiceId();
  registerShutdownHandlers(serviceId);

  validateSharedEnv();
  validatePaymentEnv();

  const producer = await createProducer({ serviceId });
  const consumer = await createConsumer({ groupId: serviceId });

  onShutdown(async () => {
    await producer.disconnect();
  });

  onShutdown(async () => {
    await consumer.disconnect();
  });

  const paymentEventsProducer = createPaymentEventsProducer(producer);
  const paymentEventsHandler = createPaymentEventsHandler();
  const rideEventsHandler = createRideEventsHandler({
    paymentEventsProducer,
  });

  const paymentEventsConsumer = createPaymentEventsConsumer({
    paymentEventsHandler,
  });
  const rideEventsConsumer = createRideEventsConsumer({
    rideEventsHandler,
  });

  await consumer.subscribe(
    [TOPICS.PAYMENT_EVENTS, TOPICS.RIDE_EVENTS],
    async (value, ctx) => {
      if (ctx.topic === TOPICS.PAYMENT_EVENTS) {
        await paymentEventsConsumer.handle(value, ctx);
        return;
      }

      if (ctx.topic === TOPICS.RIDE_EVENTS) {
        await rideEventsConsumer.handle(value, ctx);
      }
    },
  );

  console.log(`[${serviceId}] consuming`);
}
