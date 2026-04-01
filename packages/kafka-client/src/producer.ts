import { Kafka, Producer, CompressionTypes } from 'kafkajs';
import type { ProducerOptions, KafkaHeaders } from './types';

// Shared Kafka instance — created once from env, reused across all producers
// in the same process. Services should call createProducer once at startup
// and hold the reference for the lifetime of the process.
function getKafkaInstance(): Kafka {
  const brokers = process.env.KAFKA_BROKERS;
  if (!brokers) throw new Error('KAFKA_BROKERS env var is required');

  return new Kafka({
    clientId:  process.env.SERVICE_NAME ?? 'wheleers-service',
    brokers:   brokers.split(','),
    retry: {
      retries:          8,
      initialRetryTime: 300,
      factor:           2,
      multiplier:       2,
      maxRetryTime:     30_000,
    },
    // Suppress KafkaJS internal logs in production — use packages/logger instead
    logLevel: process.env.NODE_ENV === 'development' ? 2 : 1, // WARN in prod
  });
}

export interface WheleersProducer {
  // Produce a single typed event to a topic.
  // key: partition key — use userId or rideId for ordering guarantees.
  produce(topic: string, event: Record<string, unknown>, key?: string): Promise<void>;

  // Produce multiple events in a single broker round-trip.
  // All must go to the same topic.
  produceMany(topic: string, events: Array<{ event: Record<string, unknown>; key?: string }>): Promise<void>;

  // Cleanly disconnect — call in process shutdown handler.
  disconnect(): Promise<void>;
}

export function createProducer(
  serviceId: string,
  options: ProducerOptions = {},
): WheleersProducer {
  const kafka = getKafkaInstance();
  const { maxRetries = 5, idempotent = true } = options;

  const producer: Producer = kafka.producer({
    idempotent,
    maxInFlightRequests: idempotent ? 1 : undefined, // required for idempotent
    retry: { retries: maxRetries },
  });

  let connected = false;

  async function ensureConnected() {
    if (!connected) {
      await producer.connect();
      connected = true;
    }
  }

  function buildHeaders(): KafkaHeaders {
    return {
      'x-service-id':     serviceId,
      'x-schema-version': '1',
      'x-produced-at':    new Date().toISOString(),
    };
  }

  return {
    async produce(topic, event, key) {
      await ensureConnected();

      await producer.send({
        topic,
        compression: CompressionTypes.GZIP,
        messages: [
          {
            key:     key ?? null,
            value:   JSON.stringify(event),
            headers: buildHeaders(),
          },
        ],
      });
    },

    async produceMany(topic, events) {
      await ensureConnected();

      await producer.send({
        topic,
        compression: CompressionTypes.GZIP,
        messages: events.map(({ event, key }) => ({
          key:     key ?? null,
          value:   JSON.stringify(event),
          headers: buildHeaders(),
        })),
      });
    },

    async disconnect() {
      if (connected) {
        await producer.disconnect();
        connected = false;
      }
    },
  };
}