import { z } from 'zod';

const WalletEnvSchema = z.object({
  // Platform hot wallet private key — used to sign on-chain transactions
  PLATFORM_PRIVATE_KEY:      z.string().min(1),
  // RPC endpoints per chain
  RPC_URL_BASE:              z.string().url(),
  RPC_URL_POLYGON:           z.string().url().optional(),
  RPC_URL_MAINNET:           z.string().url().optional(),
  RPC_URL_ARBITRUM:          z.string().url().optional(),
  // Solana
  SOLANA_RPC_URL:            z.string().url().optional(),
  // Stellar / Soroban
  STELLAR_HORIZON_URL:       z.string().url().optional(),
  STELLAR_SOROBAN_RPC_URL:   z.string().url().optional(),
  // Smart account factory address (ERC-4337)
  SMART_ACCOUNT_FACTORY:     z.string().optional(),
  // Default chain for settlement
  DEFAULT_CHAIN:             z.string().default('base'),
});

export type WalletEnv = z.infer<typeof WalletEnvSchema>;

export function validateWalletEnv(): WalletEnv {
  const result = WalletEnvSchema.safeParse(process.env);
  if (!result.success) {
    console.error('[config] wallet-service env errors:\n', result.error.format());
    process.exit(1);
  }
  return result.data;
}