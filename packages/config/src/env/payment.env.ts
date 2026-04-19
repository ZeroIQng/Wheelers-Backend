import { z } from 'zod';

const PaymentEnvSchema = z.object({
  PAYMENT_PROVIDER:         z.literal('pouch').default('pouch'),
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
