import { Kafka, Consumer } from 'kafkajs';
import { withErrorBoundary } from './middleware';
import type { MessageHandler, MessageMeta, ConsumerOptions } from './types';

export interface WheleersConsumer {
  // Register a typed handler for a topic.
  // Call this before run() — you can subscribe to multiple topics.
  subscribe<T>(
    topic: string,
    handler: MessageHandler<T>,
    parser: (raw: string) => T,
  ): void;

  // Start the consumer loop. Blocks until disconnect() is called.
  run(): Promise<void>;

  // Cleanly disconnect — call in SIGTERM/SIGINT handler.
  disconnect(): Promise<void>;
}

export function createConsumer(
  groupId: string,
  options: ConsumerOptions = {},
): WheleersConsumer {
  const brokers = process.env.KAFKA_BROKERS;
  if (!brokers) throw new Error('KAFKA_BROKERS env var is required');

  const {
    fromBeginning    = false,
    concurrency      = 1,
    sessionTimeout   = 30_000,
    heartbeatInterval = 3_000,
  } = options;

  const kafka = new Kafka({
    clientId: `${process.env.SERVICE_NAME ?? 'wheleers'}-${groupId}`,
    brokers: brokers.split(','),
    retry: {
      retries:          8,
      initialRetryTime: 300,
      factor:           2,
    },
  });

  const consumer: Consumer = kafka.consumer({
    groupId,
    sessionTimeout,
    heartbeatInterval,
    // Allow some lag before rebalance — smooths over slow handlers
    rebalanceTimeout: 60_000,
  });

  // Topic → { handler, parser } registry — built up via subscribe()
  type HandlerEntry = {
    handler: MessageHandler<unknown>;
    parser:  (raw: string) => unknown;
  };
  const handlers = new Map<string, HandlerEntry>();

  return {
    subscribe(topic, handler, parser) {
      handlers.set(topic, {
        handler: handler as MessageHandler<unknown>,
        parser:  parser as (raw: string) => unknown,
      });
    },

    async run() {
      await consumer.connect();

      // Subscribe to all registered topics in one call
      for (const topic of handlers.keys()) {
        await consumer.subscribe({ topic, fromBeginning });
      }

      await consumer.run({
        // partitionsConsumedConcurrently controls parallel partition processing
        partitionsConsumedConcurrently: concurrency,

        eachMessage: async ({ topic, partition, message }) => {
          const raw = message.value?.toString() ?? null;
          const entry = handlers.get(topic);

          if (!entry) {
            process.stderr.write(`No handler registered for topic: ${topic}\n`);
            return;
          }

          const meta: MessageMeta = {
            topic,
            partition,
            offset:    message.offset,
            timestamp: message.timestamp,
            headers:   message.headers as MessageMeta['headers'],
            rawMessage: message,
          };

          // Full middleware chain: parse → handler → retry on transient error → DLQ on exhaustion
          await withErrorBoundary(
            async () => {
              if (!raw) throw new Error('Received null message value — skipping');
              const parsed = entry.parser(raw);
              await entry.handler(parsed, meta);
            },
            { topic, rawMessage: raw },
          );
        },
      });
    },

    async disconnect() {
      await consumer.disconnect();
    },
  };
}