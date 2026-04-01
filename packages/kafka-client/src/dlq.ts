import { Kafka, CompressionTypes } from 'kafkajs';
import type { DLQMetadata } from './types';

// DLQ producer is a separate singleton from the main producer.
// It intentionally uses fewer retries — if we can't write to the DLQ,
// we log to stderr and move on rather than crashing the consumer.
let dlqProducer: ReturnType<Kafka['producer']> | null = null;
let dlqConnected = false;

async function getDLQProducer() {
  if (dlqProducer && dlqConnected) return dlqProducer;

  const brokers = process.env.KAFKA_BROKERS;
  if (!brokers) throw new Error('KAFKA_BROKERS env var is required');

  const kafka = new Kafka({
    clientId: `${process.env.SERVICE_NAME ?? 'wheleers'}-dlq`,
    brokers: brokers.split(','),
    retry: { retries: 2 },
  });

  dlqProducer = kafka.producer({ idempotent: false });
  await dlqProducer.connect();
  dlqConnected = true;
  return dlqProducer;
}

// Sends a failed message to its DLQ topic ({originalTopic}.dlq).
// Enriches headers with full error context for post-mortem debugging.
// NEVER throws — a failing DLQ send must not crash the consumer loop.
export async function sendToDLQ(
  originalTopic: string,
  rawMessage: string | Buffer | null,
  error: unknown,
  metadata: Partial<DLQMetadata> = {},
): Promise<void> {
  const err = error instanceof Error ? error : new Error(String(error));
  const dlqTopic = `${originalTopic}.dlq`;

  const enrichedMetadata: DLQMetadata = {
    originalTopic,
    failedAt:     new Date().toISOString(),
    serviceId:    process.env.SERVICE_NAME ?? 'unknown',
    errorMessage: err.message,
    errorStack:   err.stack,
    attemptCount: metadata.attemptCount ?? 1,
  };

  try {
    const producer = await getDLQProducer();

    await producer.send({
      topic: dlqTopic,
      compression: CompressionTypes.GZIP,
      messages: [
        {
          value: rawMessage ?? Buffer.from('null'),
          headers: {
            'x-dlq-original-topic':  originalTopic,
            'x-dlq-failed-at':       enrichedMetadata.failedAt,
            'x-dlq-service-id':      enrichedMetadata.serviceId,
            'x-dlq-error-message':   enrichedMetadata.errorMessage,
            'x-dlq-error-stack':     enrichedMetadata.errorStack ?? '',
            'x-dlq-attempt-count':   String(enrichedMetadata.attemptCount),
            'x-dlq-metadata':        JSON.stringify(enrichedMetadata),
          },
        },
      ],
    });
  } catch (dlqError) {
    // DLQ send failed — last resort is stderr. Never throw.
    process.stderr.write(
      JSON.stringify({
        level:    'error',
        msg:      'Failed to write to DLQ — message lost',
        dlqTopic,
        originalError: err.message,
        dlqError: dlqError instanceof Error ? dlqError.message : String(dlqError),
        rawMessage: rawMessage?.toString().slice(0, 500), // truncate for log safety
        timestamp: new Date().toISOString(),
      }) + '\n',
    );
  }
}