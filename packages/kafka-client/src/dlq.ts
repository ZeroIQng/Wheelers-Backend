import type { Producer }    from 'kafkajs';
import { getKafkaInstance } from './connection';
import type { DlqPayload }  from './types';

let dlqProducer: Producer | null = null;

async function getDlqProducer(): Promise<Producer> {
  if (dlqProducer) return dlqProducer;
  const kafka  = getKafkaInstance();
  dlqProducer  = kafka.producer({ allowAutoTopicCreation: false });
  await dlqProducer.connect();
  return dlqProducer;
}

// Parks a failed message in <originalTopic>.dlq for manual inspection.
// Called automatically by the consumer — never call this in service code.
export async function sendToDlq(payload: DlqPayload): Promise<void> {
  const dlqTopic = `${payload.originalTopic}.dlq`;

  try {
    const producer = await getDlqProducer();
    await producer.send({
      topic:    dlqTopic,
      messages: [{
        key:   Buffer.from(payload.originalTopic),
        value: Buffer.from(JSON.stringify(payload)),
        headers: {
          'x-dlq-source':    payload.originalTopic,
          'x-dlq-reason':    payload.error.slice(0, 200),
          'x-dlq-failed-at': payload.failedAt,
        },
      }],
    });
  } catch (err) {
    // Log loudly but don't crash — losing a DLQ write is less critical
    // than halting the consumer entirely.
    console.error(
      `[kafka-client] CRITICAL: Could not write to DLQ "${dlqTopic}". ` +
      `Original error: ${payload.error}. ` +
      `DLQ write error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function disconnectDlq(): Promise<void> {
  if (dlqProducer) {
    await dlqProducer.disconnect();
    dlqProducer = null;
  }
}