import { z } from 'zod';

// Any service that needs to notify a user produces one of these events.
// notification-worker is the ONLY consumer — it owns all push/SMS/in-app logic.
// This keeps every other service free of notification SDK dependencies.

const BaseNotificationEvent = z.object({
  notificationId: z.string().uuid(),
  userId:         z.string().uuid(),
  timestamp:      z.string().datetime(),
});

// Standard push notification via Expo (React Native).
// Consumed by: notification-worker → Expo Push API.
export const PushSendEvent = BaseNotificationEvent.extend({
  eventType:   z.literal('PUSH_SEND'),
  title:       z.string().max(100),
  body:        z.string().max(300),
  data:        z.record(z.string(), z.string()).optional(), // deep-link params for the app
  priority:    z.enum(['normal', 'high']).default('normal'),
  // high priority = driver ride request (wakes screen), normal = everything else
});

// SMS fallback — used when user has no push token (web users, opt-outs).
// Consumed by: notification-worker → Twilio.
export const SmsSendEvent = BaseNotificationEvent.extend({
  eventType:   z.literal('SMS_SEND'),
  phoneNumber: z.string(),
  body:        z.string().max(160),
});

// In-app notification — stored in DB, shown in notification centre.
// Always produced alongside PUSH_SEND for persistence.
// Consumed by: notification-worker (write to notifications table),
// api-gateway (push to user's open WebSocket if active).
export const InAppSendEvent = BaseNotificationEvent.extend({
  eventType:    z.literal('IN_APP_SEND'),
  title:        z.string().max(100),
  body:         z.string().max(500),
  category:     z.enum([
    'ride',
    'payment',
    'wallet',
    'defi',
    'dispute',
    'kyc',
    'system',
  ]),
  referenceId:  z.string().optional(), // rideId, paymentId etc for deep-link
  referenceType: z.enum([
    'ride', 'payment', 'wallet', 'dispute', 'defi_position',
  ]).optional(),
  read:         z.boolean().default(false),
});

export const NotificationEvent = z.discriminatedUnion('eventType', [
  PushSendEvent,
  SmsSendEvent,
  InAppSendEvent,
]);

export type PushSendEvent      = z.infer<typeof PushSendEvent>;
export type SmsSendEvent       = z.infer<typeof SmsSendEvent>;
export type InAppSendEvent     = z.infer<typeof InAppSendEvent>;
export type NotificationEvent  = z.infer<typeof NotificationEvent>;