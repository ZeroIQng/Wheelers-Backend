import type { IHeaders }    from 'kafkajs';
import { getKafkaInstance } from './connection';
import { sendToDlq }        from './dlq';
import type {
  ConsumerConfig,
  MessageContext,
  MessageHandler,
  WheelersConsumer,
} from './types';

export async function createConsumer(config: ConsumerConfig): Promise<WheelersConsumer> {
  const kafka    = getKafkaInstance();
  const consumer = kafka.consumer({
    groupId:         config.groupId,
    maxWaitTimeInMs: config.maxWaitTimeMs ?? 100,
    retry:           { retries: 5, initialRetryTime: 300, factor: 2 },
  });

  await consumer.connect();

  return {
    async subscribe(topics, handler) {
      for (const topic of topics) {
        await consumer.subscribe({
          topic,
          fromBeginning: config.fromBeginning ?? false,
        });
      }

      await consumer.run({
        // Offset committed after eachMessage resolves — handlers must be
        // idempotent since a crash mid-handler will re-deliver on restart.
        autoCommit: true,
        partitionsConsumedConcurrently: config.concurrency ?? 1,

        eachMessage: async ({ topic, partition, message }) => {
          const rawValue = message.value?.toString() ?? '';
          const offset   = message.offset;

          const context: MessageContext = {
            topic,
            partition,
            offset,
            timestamp: message.timestamp,
            headers:   flattenHeaders(message.headers),
          };

          try {
            let parsed: unknown;
            try {
              parsed = JSON.parse(rawValue);
            } catch {
              throw new Error(`JSON parse failed on topic "${topic}" offset ${offset}`);
            }

            await (handler as MessageHandler<unknown>)(parsed, context);

          } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));

            console.error(
              `[kafka-client] Handler error — topic="${topic}" ` +
              `partition=${partition} offset=${offset}: ${error.message}`,
            );

            await sendToDlq({
              originalTopic: topic,
              rawValue,
              error:         error.message,
              stack:         error.stack,
              failedAt:      new Date().toISOString(),
              partition,
              offset,
            });
            // Does not re-throw — offset commits, consumer keeps running
          }
        },
      });
    },

    async disconnect() {
      await consumer.disconnect();
    },
  };
}

// ─── Internal ─────────────────────────────────────────────────────────────────

function flattenHeaders(raw: IHeaders | undefined): Record<string, string> {
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(raw)) {
    if (val === undefined) continue;
    if (Array.isArray(val)) {
      const last = val[val.length - 1];
      if (last !== undefined) {
        out[key] = Buffer.isBuffer(last) ? last.toString('utf8') : String(last);
      }
    } else {
      out[key] = Buffer.isBuffer(val) ? val.toString('utf8') : String(val);
    }
  }
  return out;
}