import { paymentClient } from '@wheleers/db';
import type {
  PaymentSessionCreatedEvent,
  PaymentSessionSyncedEvent,
} from '@wheleers/kafka-schemas';
import { buildIntentUpsertPayload } from '../domain/payment-intent';

export async function recordPaymentIntent(
  event: PaymentSessionCreatedEvent | PaymentSessionSyncedEvent,
): Promise<void> {
  await paymentClient.upsertPaymentIntent(buildIntentUpsertPayload(event));
}
