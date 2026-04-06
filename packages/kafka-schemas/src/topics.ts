export const TOPICS = {
  USER_EVENTS:          'user.events',
  DRIVER_EVENTS:        'driver.events',
  RIDE_EVENTS:          'ride.events',
  PAYMENT_EVENTS:       'payment.events',
  WALLET_EVENTS:        'wallet.events',
  GPS_STREAM:           'gps.stream',
  GPS_PROCESSED:        'gps.processed',
  DEFI_EVENTS:          'defi.events',
  COMPLIANCE_EVENTS:    'compliance.events',
  NOTIFICATION_EVENTS:  'notification.events',

  // Dead-letter queues — one per topic
  USER_EVENTS_DLQ:          'user.events.dlq',
  DRIVER_EVENTS_DLQ:        'driver.events.dlq',
  RIDE_EVENTS_DLQ:          'ride.events.dlq',
  PAYMENT_EVENTS_DLQ:       'payment.events.dlq',
  WALLET_EVENTS_DLQ:        'wallet.events.dlq',
  GPS_STREAM_DLQ:           'gps.stream.dlq',
  GPS_PROCESSED_DLQ:        'gps.processed.dlq',
  DEFI_EVENTS_DLQ:          'defi.events.dlq',
  COMPLIANCE_EVENTS_DLQ:    'compliance.events.dlq',
  NOTIFICATION_EVENTS_DLQ:  'notification.events.dlq',
} as const;

export type Topic = (typeof TOPICS)[keyof typeof TOPICS];

// Convenience — given any topic, return its DLQ topic name
export function dlqTopic(topic: Topic): string {
  if (topic.endsWith('.dlq')) return topic;
  return `${topic}.dlq`;
}
