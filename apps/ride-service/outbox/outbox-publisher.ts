import { outboxClient } from '@wheleers/db';
import type { WheelersProducer } from '@wheleers/kafka-client';

/** Minimal interface satisfied by the KafkaJS producer returned by createProducer. */
export interface RawProducer {
  send(record: {
    topic: string;
    messages: Array<{ key?: string | null; value: string }>;
  }): Promise<unknown>;
}

/**
 * Adapter: converts WheelersProducer (high-level) to RawProducer (KafkaJS-like).
 * This allows the outbox-publisher to accept either type.
 */
export function asRawProducer(producer: WheelersProducer): RawProducer {
  return {
    send: async (record) => {
      for (const msg of record.messages) {
        await producer.send(
          record.topic,
          JSON.parse(msg.value),
          { key: msg.key ?? undefined }
        );
      }
    },
  };
}

export function startOutboxPublisher(params: {
  producer: RawProducer;
  intervalMs?: number;
  batchSize?: number;
}): { shutdown: () => void } {
  const { producer, intervalMs = 2_000, batchSize = 100 } = params;
  let active = true;
  let polling = false;

  async function poll(): Promise<void> {
    if (!active || polling) return;
    polling = true;
    try {
      await doPoll();
    } finally {
      polling = false;
    }
  }

  async function doPoll(): Promise<void> {

    let events: Awaited<ReturnType<typeof outboxClient.findUnpublished>>;
    try {
      events = await outboxClient.findUnpublished(batchSize);
    } catch (err) {
      console.warn('[outbox-publisher] db read error:', (err as Error).message);
      return;
    }

    if (events.length === 0) return;

    const published: string[] = [];

    for (const ev of events) {
      try {
        await producer.send({
          topic: ev.topic,
          messages: [
            {
              key: ev.key ?? null,
              value: JSON.stringify(ev.payload),
            },
          ],
        });
        published.push(ev.id);
      } catch (err) {
        // Stop processing this batch; Kafka is likely unavailable.
        // Already-published IDs will be marked below; this event retries next poll.
        console.warn(
          `[outbox-publisher] send failed for event ${ev.id}:`,
          (err as Error).message,
        );
        break;
      }
    }

    if (published.length > 0) {
      try {
        await outboxClient.markPublished(published);
      } catch (err) {
        // Non-fatal: events will be re-sent next poll (idempotent on consumer side).
        console.warn(
          '[outbox-publisher] markPublished error (will retry):',
          (err as Error).message,
        );
      }
    }
  }

  // Kick off immediately, then on interval.
  void poll();
  const timer = setInterval(() => { void poll(); }, intervalMs);
  timer.unref();

  // Nightly purge of old published events.
  const purgeTimer = setInterval(
    () => { void outboxClient.purgePublished(7).catch(console.warn); },
    24 * 60 * 60 * 1_000,
  );
  purgeTimer.unref();

  return {
    shutdown() {
      active = false;
      clearInterval(timer);
      clearInterval(purgeTimer);
    },
  };
}
