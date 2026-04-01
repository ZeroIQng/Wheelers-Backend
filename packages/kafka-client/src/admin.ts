import { getKafkaInstance }  from './connection';
import type { TopicDefinition } from './types';

export const TOPIC_PRESETS = {
  GPS:        { numPartitions: 8, replicationFactor: 1, retentionMs: 86_400_000 },       // 1 day
  STANDARD:   { numPartitions: 4, replicationFactor: 1, retentionMs: 604_800_000 },      // 7 days
  LOW_VOLUME: { numPartitions: 2, replicationFactor: 1, retentionMs: 604_800_000 },      // 7 days
  DLQ:        { numPartitions: 1, replicationFactor: 1, retentionMs: 2_592_000_000 },    // 30 days
} as const;

// Creates topics that don't already exist. Safe to call on every startup.
// Services call this before connecting producer/consumer so they never
// produce to a non-existent topic.
//
// Usage:
//   await ensureTopics([
//     { name: TOPICS.RIDE_EVENTS,      ...TOPIC_PRESETS.STANDARD },
//     { name: TOPICS.RIDE_EVENTS_DLQ,  ...TOPIC_PRESETS.DLQ     },
//   ]);
export async function ensureTopics(topics: TopicDefinition[]): Promise<void> {
  const kafka = getKafkaInstance();
  const admin = kafka.admin();
  await admin.connect();

  try {
    const existing = new Set(await admin.listTopics());
    const toCreate  = topics.filter(t => !existing.has(t.name));

    if (toCreate.length === 0) {
      console.log('[kafka-client] All required topics already exist.');
      return;
    }

    await admin.createTopics({
      waitForLeaders: true,
      topics: toCreate.map(t => ({
        topic:             t.name,
        numPartitions:     t.numPartitions,
        replicationFactor: t.replicationFactor,
        configEntries: [{
          name:  'retention.ms',
          value: String(t.retentionMs ?? 604_800_000),
        }],
      })),
    });

    console.log(
      `[kafka-client] Created topics: ${toCreate.map(t => t.name).join(', ')}`,
    );
  } finally {
    await admin.disconnect();
  }
}

// Helper — builds a full topic list from name+preset pairs and automatically
// appends the DLQ counterpart for each non-DLQ topic.
//
// Usage:
//   await ensureTopics(buildTopicList([
//     [TOPICS.RIDE_EVENTS,   TOPIC_PRESETS.STANDARD],
//     [TOPICS.GPS_STREAM,    TOPIC_PRESETS.GPS],
//   ]));
export function buildTopicList(
  entries: Array<[name: string, preset: typeof TOPIC_PRESETS[keyof typeof TOPIC_PRESETS]]>,
): TopicDefinition[] {
  const result: TopicDefinition[] = [];
  for (const [name, preset] of entries) {
    result.push({ name, ...preset });
    if (!name.endsWith('.dlq')) {
      result.push({ name: `${name}.dlq`, ...TOPIC_PRESETS.DLQ });
    }
  }
  return result;
}