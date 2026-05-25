import { z } from 'zod';

const GatewayEnvSchema = z.object({
  PORT:               z.string().default('3000'),
  AWS_REGION:         z.string().min(1).optional(),
  STELLAR_NETWORK:    z.enum(['mainnet', 'testnet']).default('mainnet'),
  JWT_SECRET:         z.string().min(32).optional(),
  PRIVY_APP_ID:       z.string().min(1),
  PRIVY_VERIFICATION_KEY: z.string().min(1),
  WHATSAPP_GATEWAY_URL: z.string().url().optional(),
  WHATSAPP_GATEWAY_TOKEN: z.string().min(1).optional(),
  WHATSAPP_OTP_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  // Legacy SMS fallback. Prefer the WhatsApp gateway for OTP delivery.
  TWILIO_ACCOUNT_SID: z.string().min(1).optional(),
  TWILIO_AUTH_TOKEN:  z.string().min(1).optional(),
  TWILIO_FROM_NUMBER: z.string().min(1).optional(),
  POUCH_API_KEY:      z.string().min(1),
  POUCH_BASE_URL:     z.string().url().default('https://api.pouch.finance'),
  POUCH_WEBHOOK_SECRET: z.string().min(1).optional(),
  POUCH_PROVIDER_ID:  z.string().min(1).default('yellowcard'),
  POUCH_COUNTRY_CODE: z.string().length(2).default('NG'),
  POUCH_FIAT_CURRENCY: z.string().min(3).default('NGN'),
  POUCH_CRYPTO_CURRENCY: z.string().min(1).default('USDC'),
  POUCH_CRYPTO_NETWORK: z.string().min(1).default('XLM'),
  POUCH_CHAIN: z.string().min(1).default('XLM'),
  POUCH_MASTER_WALLET_ADDRESS: z.string().min(1),
  STELLAR_MASTER_WALLET_SECRET_NAME: z.string().min(1).optional(),
  STELLAR_SECRET_KEY: z.string().min(1).optional(),
  POUCH_WALLET_TAG: z.string().min(1).optional(),
  POUCH_TEST_EMAIL: z.string().email().optional(),
  POUCH_FULL_NAME: z.string().min(1).optional(),
  POUCH_PHONE: z.string().min(1).optional(),
  POUCH_ADDRESS: z.string().min(1).optional(),
  POUCH_DOB: z.string().min(1).optional(),
  POUCH_NIN: z.string().min(1).optional(),
  POUCH_BVN: z.string().min(1).optional(),
  COINGECKO_BASE_URL: z.string().url().default('https://api.coingecko.com/api/v3'),
  GOOGLE_MAPS_API_KEY: z.string().min(1),
  GOOGLE_MAPS_BASE_URL: z.string().url().default('https://routes.googleapis.com'),
  GROUP_RIDE_FACE_S3_BUCKET: z.string().min(1).optional(),
  GROUP_RIDE_FACE_S3_PREFIX: z.string().min(1).default('group-rides/face-verification'),
  GROUP_RIDE_FACE_UPLOAD_URL_TTL_S: z.coerce.number().int().positive().default(900),
  // Rider-facing fare display only. Internal ride settlement remains in USDT.
  RIDE_DISPLAY_NGN_PER_USDT_FALLBACK: z.coerce.number().positive().default(1600),
  RIDE_DISPLAY_RATE_TTL_MS: z.coerce.number().int().positive().default(60000),
  // Must match ride-service so BullMQ enqueue timing aligns with dispatcher recovery.
  SCHEDULED_RIDE_DISPATCH_LEAD_TIME_S: z.coerce.number().int().positive().default(300),
  // Comma-separated list of allowed WebSocket/HTTP origins
  CORS_ORIGINS:       z.string().default('http://localhost:19006,https://app.wheelersng.com'),
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
