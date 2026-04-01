import { CompressionTypes }   from 'kafkajs';
import { getKafkaInstance }   from './connection';
import type {
  ProducerConfig,
  SendOptions,
  WheelersProducer,
} from './types';

export async function createProducer(config: ProducerConfig): Promise<WheelersProducer> {
  const kafka = getKafkaInstance();

  const producer = kafka.producer({
    allowAutoTopicCreation: false,
    retry: {
      retries:          config.retries          ?? 5,
      initialRetryTime: config.initialRetryTime ?? 300,
      factor:           2,
      maxRetryTime:     30_000,
    },
  });

  await producer.connect();

  const serviceId          = config.serviceId;
  const defaultCompression = config.compression ?? CompressionTypes.None;

  return {
    async send(topic, value, options = {}) {
      await producer.send({
        topic,
        compression: options.compression ?? defaultCompression,
        messages:    [buildMessage(value, options, serviceId)],
      });
    },

    async sendBatch(messages) {
      const byTopic: Record<string, { topic: string; messages: ReturnType<typeof buildMessage>[] }> = {};

      for (const { topic, value, options = {} } of messages) {
        if (!byTopic[topic]) byTopic[topic] = { topic, messages: [] };
        byTopic[topic]!.messages.push(buildMessage(value, options, serviceId));
      }

      await producer.sendBatch({
        compression:   defaultCompression,
        topicMessages: Object.values(byTopic),
      });
    },

    async disconnect() {
      await producer.disconnect();
    },
  };
}

function buildMessage(
  value:     Record<string, unknown>,
  options:   SendOptions,
  serviceId: string,
) {
  return {
    key:   options.key ? Buffer.from(options.key) : null,
    value: Buffer.from(JSON.stringify(value)),
    headers: {
      'x-source-service': serviceId,
      ...(options.headers ?? {}),
    },
  };
}