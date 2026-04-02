import { z } from 'zod';

const SharedEnvSchema = z.object({
  NODE_ENV:       z.enum(['development', 'production', 'test']),
  DATABASE_URL:   z.string().url(),
  KAFKA_BROKERS:  z.string().min(1),   // "host1:9092,host2:9092"
  KAFKA_CLIENT_ID: z.string().min(1),  // e.g. "ride-service"
  REDIS_URL:      z.string().url(),
});

export type SharedEnv = z.infer<typeof SharedEnvSchema>;

// Call this at the top of every service's index.ts.
// Crashes immediately with a clear message if any var is missing —
// far better than a cryptic runtime error 30 seconds into startup.
export function validateSharedEnv(): SharedEnv {
  const result = SharedEnvSchema.safeParse(process.env);
  if (!result.success) {
    console.error(
      '[config] Missing required environment variables:\n',
      result.error.format(),
    );
    process.exit(1);
  }
  return result.data;
}