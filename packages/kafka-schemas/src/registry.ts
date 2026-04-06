import { z } from 'zod';
import { TOPICS } from './topics';
import { UserEvent }         from './events/user.events';
import { DriverEvent }       from './events/driver.events';
import { RideEvent }         from './events/ride.events';
import { PaymentEvent }      from './events/payment.events';
import { WalletEvent }       from './events/wallet.events';
import { GpsUpdateEvent, GpsProcessedEvent } from './events/gps.events';
import { ComplianceEvent }   from './events/compliance.events';
import { DefiEvent }         from './events/defi.events';
import { NotificationEvent } from './events/notification.events';

// Maps every live topic to its Zod discriminated union schema.
// DLQ topics are intentionally omitted — DLQ messages are raw strings
// stored for manual inspection, not typed events.
const TOPIC_SCHEMAS = {
  [TOPICS.USER_EVENTS]:         UserEvent,
  [TOPICS.DRIVER_EVENTS]:       DriverEvent,
  [TOPICS.RIDE_EVENTS]:         RideEvent,
  [TOPICS.PAYMENT_EVENTS]:      PaymentEvent,
  [TOPICS.WALLET_EVENTS]:       WalletEvent,
  [TOPICS.GPS_STREAM]:          GpsUpdateEvent,
  [TOPICS.GPS_PROCESSED]:       GpsProcessedEvent,
  [TOPICS.COMPLIANCE_EVENTS]:   ComplianceEvent,
  [TOPICS.DEFI_EVENTS]:         DefiEvent,
  [TOPICS.NOTIFICATION_EVENTS]: NotificationEvent,
} as const;

type LiveTopic = keyof typeof TOPIC_SCHEMAS;

// Use this in every consumer.
// Parses the raw Kafka message value and validates it against the topic's schema.
// Throws a ZodError (caught by kafka-client's error boundary → DLQ) if invalid.
//
// Usage:
//   const event = parseKafkaEvent(TOPICS.RIDE_EVENTS, message.value.toString());
//   if (event.eventType === 'RIDE_COMPLETED') { ... }
export function parseKafkaEvent<T extends LiveTopic>(
  topic: T,
  rawValue: unknown,
): z.infer<(typeof TOPIC_SCHEMAS)[T]> {
  const schema = TOPIC_SCHEMAS[topic];
  const parsed = coerceAndParseJson(rawValue, topic);
  return schema.parse(parsed);
}

// Safe version — returns null instead of throwing.
// Use when you want to log and skip bad messages without crashing the consumer.
export function safeParseKafkaEvent<T extends LiveTopic>(
  topic: T,
  rawValue: unknown,
): z.infer<(typeof TOPIC_SCHEMAS)[T]> | null {
  try {
    return parseKafkaEvent(topic, rawValue);
  } catch {
    return null;
  }
}

// Serialises an event to a JSON string for Kafka producer.
// Usage: produceMessage(TOPICS.RIDE_EVENTS, serializeEvent(rideCompletedEvent));
export function serializeEvent(event: Record<string, unknown>): string {
  return JSON.stringify(event);
}

export type { LiveTopic };

function coerceAndParseJson(rawValue: unknown, topic: string): unknown {
  if (rawValue === null || rawValue === undefined) {
    throw new Error(`[kafka-schemas] Empty Kafka message value for topic "${topic}"`);
  }

  if (typeof rawValue === 'string') {
    return parseJsonString(rawValue, topic);
  }

  if (rawValue instanceof Uint8Array) {
    const text = Buffer.from(rawValue).toString('utf8');
    return parseJsonString(text, topic);
  }

  return rawValue;
}

function parseJsonString(text: string, topic: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`[kafka-schemas] JSON parse failed for topic "${topic}": ${message}`);
  }
}
