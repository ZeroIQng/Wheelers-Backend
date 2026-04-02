import { z } from 'zod';

const RideEnvSchema = z.object({
  // Radius in km to search for nearby drivers on RIDE_REQUESTED
  MATCH_RADIUS_KM:           z.string().default('5'),
  // How long to wait for a driver to accept before trying the next one (seconds)
  DRIVER_ACCEPT_TIMEOUT_S:   z.string().default('15'),
  // How many drivers to attempt matching before giving up and emitting RIDE_CANCELLED
  MAX_MATCH_ATTEMPTS:        z.string().default('5'),
  // GPS stale detection — run every N seconds
  GPS_STALE_CHECK_INTERVAL_S: z.string().default('30'),
});

export type RideEnv = z.infer<typeof RideEnvSchema>;

export function validateRideEnv(): RideEnv {
  const result = RideEnvSchema.safeParse(process.env);
  if (!result.success) {
    console.error('[config] ride-service env errors:\n', result.error.format());
    process.exit(1);
  }
  return result.data;
}