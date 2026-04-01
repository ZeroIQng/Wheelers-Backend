import type { KafkaMessage } from 'kafkajs';

// The function signature every service passes to consumer.subscribe().
// T is the parsed, validated event type from @wheleers/kafka-schemas.
export type MessageHandler<T> = (
  event: T,
  meta: MessageMeta,
) => Promise<void>;

// Kafka metadata passed alongside every parsed event to the handler.
// Useful for logging, idempotency checks, and debugging.
export interface MessageMeta {
  topic:      string;
  partition:  number;
  offset:     string;
  timestamp:  string;        // epoch ms as string (Kafka standard)
  headers:    KafkaHeaders;
  rawMessage: KafkaMessage;  // escape hatch — avoid using directly
}

// Headers attached to every produced message by this package.
export interface KafkaHeaders {
  'x-service-id'?:     string;  // which service produced this message
  'x-schema-version'?: string;  // for future schema migration tracking
  [key: string]: string | Buffer | undefined;
}

// Options passed to createProducer.
export interface ProducerOptions {
  // Max retries before giving up on a single produce call. Default: 5.
  maxRetries?: number;
  // Enable idempotent producer (exactly-once at broker level). Default: true.
  idempotent?: boolean;
}

// Options passed to createConsumer.
export interface ConsumerOptions {
  // Read from the beginning of the topic on first connect. Default: false.
  fromBeginning?: boolean;
  // How many messages to process in parallel per partition. Default: 1.
  concurrency?: number;
  // Session timeout ms before broker considers consumer dead. Default: 30000.
  sessionTimeout?: number;
  // Heartbeat interval ms — must be < sessionTimeout / 3. Default: 3000.
  heartbeatInterval?: number;
}

// Metadata written to the DLQ message for post-mortem inspection.
export interface DLQMetadata {
  originalTopic: string;
  failedAt:      string;  // ISO timestamp
  serviceId:     string;
  errorMessage:  string;
  errorStack?:   string;
  attemptCount:  number;
}