import { z } from 'zod';

const GatewayEnvSchema = z.object({
  PORT:               z.string().default('3000'),
  AWS_REGION:         z.string().min(1).optional(),
  JWT_SECRET:         z.string().min(32),
  WHATSAPP_GATEWAY_URL: z.string().url().optional(),
  WHATSAPP_GATEWAY_TOKEN: z.string().min(1).optional(),
  WHATSAPP_OTP_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  TWILIO_ACCOUNT_SID: z.string().min(1).optional(),
  TWILIO_AUTH_TOKEN:  z.string().min(1).optional(),
  TWILIO_FROM_NUMBER: z.string().min(1).optional(),
  // Pouch Liquifia Fiat Aggregator
  POUCH_LIQUIFIA_API_KEY: z.string().min(1),
  POUCH_LIQUIFIA_BASE_URL: z.string().url().default('https://fiat-api.pouchfinance.xyz/api/v1'),
  POUCH_WEBHOOK_SECRET: z.string().min(1).optional(),
  GOOGLE_MAPS_API_KEY: z.string().min(1),
  GOOGLE_MAPS_BASE_URL: z.string().url().default('https://routes.googleapis.com'),
  GROUP_RIDE_FACE_S3_BUCKET: z.string().min(1).optional(),
  GROUP_RIDE_FACE_S3_PREFIX: z.string().min(1).default('group-rides/face-verification'),
  GROUP_RIDE_FACE_UPLOAD_URL_TTL_S: z.coerce.number().int().positive().default(900),
  RIDER_KYC_S3_BUCKET: z.string().min(1).optional(),
  RIDER_KYC_S3_PREFIX: z.string().min(1).default('rider-kyc/face-verification'),
  SCHEDULED_RIDE_DISPATCH_LEAD_TIME_S: z.coerce.number().int().positive().default(300),
  CORS_ORIGINS:       z.string().default('http://localhost:19006,https://app.wheelersng.com'),
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
