import type { CompressionTypes } from 'kafkajs';

// ─── Producer ────────────────────────────────────────────────────────────────

export interface ProducerConfig {
  // Unique name for this service — stamped into every message header
  serviceId:        string;
  retries?:         number;          // default: 5
  initialRetryTime?: number;         // ms, default: 300
  compression?:     CompressionTypes;
}

export interface SendOptions {
  // Partition key — use userId / rideId so related events stay ordered
  key?:         string;
  headers?:     Record<string, string>;
  compression?: CompressionTypes;
}

export interface WheelersProducer {
  send(
    topic:   string,
    value:   Record<string, unknown>,
    options?: SendOptions,
  ): Promise<void>;

  sendBatch(messages: Array<{
    topic:    string;
    value:    Record<string, unknown>;
    options?: SendOptions;
  }>): Promise<void>;

  disconnect(): Promise<void>;
}

// ─── Consumer ────────────────────────────────────────────────────────────────

export interface ConsumerConfig {
  groupId:       string;
  maxWaitTimeMs?: number;   // default: 100
  concurrency?:  number;    // default: 1 — keep at 1 unless handler is stateless
  fromBeginning?: boolean;  // default: false
}

export interface MessageContext {
  topic:      string;
  partition:  number;
  offset:     string;
  timestamp:  string;
  headers:    Record<string, string>;
}

// The function you write in each consumer file
export type MessageHandler<T = unknown> = (
  value:   T,
  context: MessageContext,
) => Promise<void>;

export interface WheelersConsumer {
  subscribe(topics: string[], handler: MessageHandler): Promise<void>;
  disconnect(): Promise<void>;
}

// ─── Admin ───────────────────────────────────────────────────────────────────

export interface TopicDefinition {
  name:              string;
  numPartitions:     number;
  replicationFactor: number;
  retentionMs?:      number;  // default: 7 days
}

// ─── DLQ ─────────────────────────────────────────────────────────────────────

export interface DlqPayload {
  originalTopic: string;
  rawValue:      string;
  error:         string;
  stack?:        string;
  failedAt:      string;
  partition:     number;
  offset:        string;
}