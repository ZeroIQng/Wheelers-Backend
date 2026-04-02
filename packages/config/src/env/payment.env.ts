import { z } from 'zod';

const PaymentEnvSchema = z.object({
  KORAPAY_SECRET_KEY:       z.string().min(1),
  KORAPAY_PUBLIC_KEY:       z.string().min(1),
  KORAPAY_WEBHOOK_SECRET:   z.string().min(1),
  YELLOWCARD_API_KEY:       z.string().min(1),
  YELLOWCARD_WEBHOOK_SECRET: z.string().min(1),
  YELLOWCARD_BASE_URL:      z.string().url().default('https://api.yellowcard.io'),
  // Platform wallet that receives the 0.3% fee
  PLATFORM_WALLET_ADDRESS:  z.string().min(1),
});

export type PaymentEnv = z.infer<typeof PaymentEnvSchema>;

export function validatePaymentEnv(): PaymentEnv {
  const result = PaymentEnvSchema.safeParse(process.env);
  if (!result.success) {
    console.error('[config] payment-service env errors:\n', result.error.format());
    process.exit(1);
  }
  return result.data;
}