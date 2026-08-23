import { z } from 'zod';

const GroupRideEnvSchema = z.object({
  GOOGLE_MAPS_API_KEY: z.string().min(1),
  GOOGLE_MAPS_BASE_URL: z.string().url().default('https://routes.googleapis.com'),
  GROUP_RIDE_PICKUP_RADIUS_KM: z.coerce.number().positive().default(2.5),
  GROUP_RIDE_DESTINATION_RADIUS_KM: z.coerce.number().positive().default(6),
  GROUP_RIDE_BEARING_THRESHOLD_DEG: z.coerce.number().positive().max(180).default(35),
  GROUP_RIDE_MAX_CANDIDATES: z.coerce.number().int().positive().default(6),
  GROUP_RIDE_MAX_SIZE: z.coerce.number().int().min(2).max(4).default(3),
  GROUP_RIDE_REQUEST_TTL_S: z.coerce.number().int().positive().default(1800),
});

export type GroupRideEnv = z.infer<typeof GroupRideEnvSchema>;

export function validateGroupRideEnv(): GroupRideEnv {
  const result = GroupRideEnvSchema.safeParse(process.env);
  if (!result.success) {
    console.error('[config] group-ride env errors:\n', result.error.format());
    process.exit(1);
  }

  return result.data;
}
