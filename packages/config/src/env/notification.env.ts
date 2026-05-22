import { z } from 'zod';

const NotificationEnvSchema = z.object({
  // Expo push notifications
  EXPO_ACCESS_TOKEN:     z.string().min(1),
  // Rate limiting — max pushes per user per minute
  PUSH_RATE_LIMIT:       z.string().default('10'),
});

export type NotificationEnv = z.infer<typeof NotificationEnvSchema>;

export function validateNotificationEnv(): NotificationEnv {
  const result = NotificationEnvSchema.safeParse(process.env);
  if (!result.success) {
    console.error('[config] notification-worker env errors:\n', result.error.format());
    process.exit(1);
  }
  return result.data;
}
