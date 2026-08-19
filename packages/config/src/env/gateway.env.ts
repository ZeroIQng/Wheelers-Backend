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
  GROQ_API_KEY:       z.string().min(1).optional(),
  // llama-3.3-70b-versatile was decommissioned by Groq — every ride-intent
  // parse failed with "model does not exist" and silently fell back to regex,
  // so "take me from Ikeja to Lekki" was only understood when it matched a
  // hard-coded pattern. Measured ~0.8-2.2s, inside GROQ_TIMEOUT_MS.
  GROQ_MODEL:         z.string().min(1).default('openai/gpt-oss-120b'),
  GROQ_TIMEOUT_MS:    z.coerce.number().int().positive().default(6000),
  APP_BASE_URL:       z.string().url().optional(),
  TWILIO_WHATSAPP_NUMBER: z.string().min(1).optional(),
  TWILIO_KYC_CONTENT_SID: z.string().min(1).optional(),
  // WhatsApp Flows
  WHATSAPP_FLOW_PRIVATE_KEY: z.string().min(1).optional(),
  WHATSAPP_FLOW_ID: z.string().min(1).optional(),
  WHATSAPP_DRIVER_PROFILE_FLOW_ID: z.string().min(1).optional(),
  WHATSAPP_FLOW_CONTENT_SID: z.string().min(1).optional(),
  WHATSAPP_RIDE_SEARCH_FLOW_PRIVATE_KEY: z.string().min(1).optional(),
  WHATSAPP_RIDE_SEARCH_FLOW_ID: z.string().min(1).optional(),
  META_ACCESS_TOKEN: z.string().min(1).optional(),
  META_PHONE_NUMBER_ID: z.string().min(1).optional(),
  META_APP_SECRET: z.string().min(1).optional(),
  META_WEBHOOK_VERIFY_TOKEN: z.string().min(1).optional(),
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
  CORS_ORIGINS:       z.string().default('http://localhost:19006,http://localhost:3000,https://app.wheelersng.com'),
  WS_IDLE_TIMEOUT_MS: z.string().default('60000'),
  // Social Auth
  APPLE_BUNDLE_ID:    z.string().optional().transform(v => v?.trim() || undefined),
  GOOGLE_CLIENT_ID:   z.string().optional().transform(v => v?.trim() || undefined),
  // Resend Email
  RESEND_API_KEY:     z.string().optional().transform(v => v?.trim() || undefined),
  // Cloudflare R2 Storage
  R2_ACCOUNT_ID:      z.string().optional().transform(v => v?.trim() || undefined),
  R2_ACCESS_KEY_ID:   z.string().optional().transform(v => v?.trim() || undefined),
  R2_SECRET_ACCESS_KEY: z.string().optional().transform(v => v?.trim() || undefined),
  R2_BUCKET:          z.string().optional().transform(v => v?.trim() || undefined),
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
