import { z } from 'zod';

const GatewayEnvSchema = z.object({
  PORT:               z.string().default('3000'),
  JWT_SECRET:         z.string().min(32).optional(),
  PRIVY_APP_ID:       z.string().min(1),
  PRIVY_VERIFICATION_KEY: z.string().min(1),
  POUCH_API_KEY:      z.string().min(1),
  POUCH_BASE_URL:     z.string().url().default('https://api.pouch.finance'),
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
