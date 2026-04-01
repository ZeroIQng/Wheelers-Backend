import { Kafka, logLevel } from 'kafkajs';

let instance: Kafka | null = null;

export function getKafkaInstance(): Kafka {
  if (instance) return instance;

  const brokers  = process.env['KAFKA_BROKERS'];
  const clientId = process.env['KAFKA_CLIENT_ID'];

  if (!brokers) {
    throw new Error(
      '[kafka-client] KAFKA_BROKERS is required. Format: "host1:9092,host2:9092"',
    );
  }
  if (!clientId) {
    throw new Error(
      '[kafka-client] KAFKA_CLIENT_ID is required. Set it to your service name.',
    );
  }

  instance = new Kafka({
    clientId,
    brokers: brokers.split(',').map((b: string) => b.trim()),
    retry: {
      initialRetryTime: 300,
      retries:          10,
      factor:           2,
      maxRetryTime:     30_000,
    },
    logLevel: process.env['NODE_ENV'] === 'development'
      ? logLevel.INFO
      : logLevel.ERROR,
  });

  return instance;
}

export function resetKafkaInstance(): void {
  instance = null;
}