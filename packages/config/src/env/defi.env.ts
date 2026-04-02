import { z } from 'zod';

const DefiEnvSchema = z.object({
  // Minimum USDT balance to consider "idle" and eligible for DeFi
  IDLE_THRESHOLD_USDT:    z.string().default('10'),
  // Hours a wallet must be idle before defi-scheduler acts
  IDLE_HOURS:             z.string().default('24'),
  // How often defi-scheduler runs the idle check (cron expression)
  IDLE_CHECK_CRON:        z.string().default('0 * * * *'), // every hour
  // Aave V3 Pool contract address
  AAVE_POOL_ADDRESS:      z.string().optional(),
  // Compound V3 Comet contract address
  COMPOUND_COMET:         z.string().optional(),
  // Minimum USDT to auto-stake (prevents tiny positions)
  MIN_STAKE_USDT:         z.string().default('5'),
});

export type DefiEnv = z.infer<typeof DefiEnvSchema>;

export function validateDefiEnv(): DefiEnv {
  const result = DefiEnvSchema.safeParse(process.env);
  if (!result.success) {
    console.error('[config] defi-scheduler env errors:\n', result.error.format());
    process.exit(1);
  }
  return result.data;
}