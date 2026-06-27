import { z } from 'zod';

const PaymentEnvSchema = z.object({
  PAYMENT_PROVIDER: z.literal('pouch').default('pouch'),
  POUCH_LIQUIFIA_API_KEY: z.string().min(1),
  POUCH_LIQUIFIA_BASE_URL: z.string().url().default('https://fiat-api.pouchfinance.xyz/api/v1'),
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
