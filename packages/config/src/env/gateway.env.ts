import { z } from 'zod';

const GatewayEnvSchema = z.object({
  PORT:               z.string().default('3000'),
  JWT_SECRET:         z.string().min(32).optional(),
  PRIVY_APP_ID:       z.string().min(1),
  PRIVY_VERIFICATION_KEY: z.string().min(1),
  TWILIO_ACCOUNT_SID: z.string().min(1).optional(),
  TWILIO_AUTH_TOKEN:  z.string().min(1).optional(),
  TWILIO_FROM_NUMBER: z.string().min(1).optional(),
  TWILIO_OTP_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  POUCH_API_KEY:      z.string().min(1),
  POUCH_BASE_URL:     z.string().url().default('https://api.pouch.finance'),
  COINGECKO_BASE_URL: z.string().url().default('https://api.coingecko.com/api/v3'),
  GOOGLE_MAPS_API_KEY: z.string().min(1),
  GOOGLE_MAPS_BASE_URL: z.string().url().default('https://routes.googleapis.com'),
  // Rider-facing fare display only. Internal ride settlement remains in USDT.
  RIDE_DISPLAY_NGN_PER_USDT_FALLBACK: z.coerce.number().positive().default(1600),
  RIDE_DISPLAY_RATE_TTL_MS: z.coerce.number().int().positive().default(60000),
  // Must match ride-service so BullMQ enqueue timing aligns with dispatcher recovery.
  SCHEDULED_RIDE_DISPATCH_LEAD_TIME_S: z.coerce.number().int().positive().default(300),
  // Comma-separated list of allowed WebSocket/HTTP origins
  CORS_ORIGINS:       z.string().default('http://localhost:19006'),
  // How long a WebSocket connection can stay idle before being dropped (ms)
  WS_IDLE_TIMEOUT_MS: z.string().default('60000'),
});

export type GatewayEnv = z.infer<typeof GatewayEnvSchema>;

export function validateGatewayEnv(): GatewayEnv {
  const result = GatewayEnvSchema.safeParse(process.env);
  if (!result.success) {
    console.error('[config] api-gateway env errors:\n', result.error.format());
    process.exit(1);
  }
  return result.data;
}
