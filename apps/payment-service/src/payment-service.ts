import { validateSharedEnv, validatePaymentEnv } from '@wheleers/config';
import {
  createConsumer,
  createProducer,
  onShutdown,
  registerShutdownHandlers,
} from '@wheleers/kafka-client';
import { TOPICS } from '@wheleers/kafka-schemas';
import { PouchLiquifiaClient } from '@wheleers/pouch-client';
import { createPaymentEventsConsumer } from './consumers/payment-events.consumer';
import { applyPaymentServiceDefaults, getPaymentServiceId } from './config/runtime';
import { createPaymentEventsHandler } from './handlers/payment-events.handler';
import { startPayoutReconciliation } from './handlers/payout-reconciliation';
import { createPaymentEventsProducer } from './producers/payment-events.producer';

export async function startPaymentService(): Promise<void> {
  applyPaymentServiceDefaults();

  const serviceId = getPaymentServiceId();
  registerShutdownHandlers(serviceId);

  validateSharedEnv();
  const paymentEnv = validatePaymentEnv();

  const producer = await createProducer({ serviceId });
  const consumer = await createConsumer({ groupId: serviceId });

  onShutdown(async () => {
    await producer.disconnect();
  });

  onShutdown(async () => {
    await consumer.disconnect();
  });

  const pouchClient = new PouchLiquifiaClient({
    baseUrl: paymentEnv.POUCH_LIQUIFIA_BASE_URL,
    apiKey: paymentEnv.POUCH_LIQUIFIA_API_KEY,
  });

  // Producer is wired up for other services (e.g. api-gateway) that may
  // import it, but the handler itself only logs for now.
  createPaymentEventsProducer(producer);

  const paymentEventsHandler = createPaymentEventsHandler({
    pouchClient,
    serviceId,
  });
  const paymentEventsConsumer = createPaymentEventsConsumer({
    paymentEventsHandler,
  });

  await consumer.subscribe(
    [TOPICS.PAYMENT_EVENTS],
    async (value, ctx) => {
      if (ctx.topic === TOPICS.PAYMENT_EVENTS) {
        await paymentEventsConsumer.handle(value, ctx);
      }
    },
  );

  const stopReconciliation = startPayoutReconciliation(pouchClient);
  onShutdown(async () => {
    stopReconciliation();
  });

  console.log(`[${serviceId}] consuming`);
}
