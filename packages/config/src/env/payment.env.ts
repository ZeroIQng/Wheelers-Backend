import { z } from 'zod';

const PaymentEnvSchema = z.object({
  PAYMENT_PROVIDER:         z.literal('paystack').default('paystack'),
  FX_PROVIDER:              z.literal('coinbase').default('coinbase'),
  COINBASE_EXCHANGE_RATES_URL: z.string().url().default('https://api.coinbase.com/v2/exchange-rates'),
  FX_QUOTE_TTL_MS:          z.coerce.number().int().positive().default(30000),
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
