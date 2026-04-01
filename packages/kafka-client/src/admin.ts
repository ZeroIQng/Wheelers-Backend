import { Kafka } from 'kafkajs';
import { TOPICS} from '@wheleers/kafka-schemas';
// Partition counts per topic — sized based on expected throughput.
// GPS topics handle ~133 events/sec at 400 concurrent users → 8 partitions.
// Core domain topics handle bursts but not sustained volume → 4 partitions.
// Low-frequency operational topics → 2 partitions.
// DLQ topics never need more than 1 — they're for inspection, not throughput.
const PARTITION_MAP: Record<string, number> = {
  [TOPICS.GPS_STREAM]:           8,
  [TOPICS.GPS_PROCESSED]:        8,
  [TOPICS.RIDE_EVENTS]:          4,
  [TOPICS.USER_EVENTS]:          4,
  [TOPICS.DRIVER_EVENTS]:        4,
  [TOPICS.PAYMENT_EVENTS]:       4,
  [TOPICS.WALLET_EVENTS]:        4,
  [TOPICS.DEFI_EVENTS]:          2,
  [TOPICS.COMPLIANCE_EVENTS]:    2,
  [TOPICS.NOTIFICATION_EVENTS]:  2,
};

// Idempotently creates all Kafka topics.
// Safe to call on every service startup — existing topics are silently skipped.
// Call this before starting any consumers or producers.
export async function ensureTopics(): Promise<void> {
  const brokers = process.env.KAFKA_BROKERS;
  if (!brokers) throw new Error('KAFKA_BROKERS env var is required');

  const replicationFactor = Number(process.env.KAFKA_REPLICATION_FACTOR ?? '1');

  const kafka = new Kafka({
    clientId: `${process.env.SERVICE_NAME ?? 'wheleers'}-admin`,
    brokers: brokers.split(','),
  });

  const admin = kafka.admin();
  await admin.connect();

  try {
    // Build the full topic list — live topics + their DLQ counterparts
    const topicsToCreate = Object.entries(PARTITION_MAP).flatMap(
      ([topic, numPartitions]) => [
        { topic, numPartitions, replicationFactor },
        // DLQ topic — always 1 partition, same replication
        {
          topic:             `${topic}.dlq`,
          numPartitions:     1,
          replicationFactor,
          configEntries: [
            // Retain DLQ messages for 7 days (longer than live topics)
            { name: 'retention.ms', value: String(7 * 24 * 60 * 60 * 1000) },
          ],
        },
      ],
    );

    await admin.createTopics({
      topics:           topicsToCreate,
      waitForLeaders:   true,
      // Don't throw if topics already exist — idempotent
    });

  } finally {
    await admin.disconnect();
  }
}

// Returns a list of all topic names currently in Kafka.
// Useful for health checks and startup validation.
export async function listTopics(): Promise<string[]> {
  const brokers = process.env.KAFKA_BROKERS;
  if (!brokers) throw new Error('KAFKA_BROKERS env var is required');

  const kafka = new Kafka({
    clientId: `${process.env.SERVICE_NAME ?? 'wheleers'}-admin-list`,
    brokers: brokers.split(','),
  });

  const admin = kafka.admin();
  await admin.connect();

  try {
    return await admin.listTopics();
  } finally {
    await admin.disconnect();
  }
}