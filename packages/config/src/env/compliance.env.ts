import { z } from 'zod';

const ComplianceEnvSchema = z.object({
  // IPFS pinning service
  IPFS_API_URL:              z.string().url(),
  IPFS_API_KEY:              z.string().min(1),
  // Stellar network used for immutable compliance logging
  STELLAR_NETWORK:           z.enum(['mainnet', 'testnet']).default('testnet'),
  STELLAR_SECRET_KEY:        z.string().min(1),
  // AES-256-GCM encryption key for recordings (32 bytes hex)
  RECORDING_ENCRYPTION_KEY:  z.string().length(64),
  // Admin dashboard URL — for dispute notification deep-links
  ADMIN_DASHBOARD_URL:       z.string().url().optional(),
});

export type ComplianceEnv = z.infer<typeof ComplianceEnvSchema>;

export function validateComplianceEnv(): ComplianceEnv {
  const result = ComplianceEnvSchema.safeParse(process.env);
  if (!result.success) {
    console.error('[config] compliance-worker env errors:\n', result.error.format());
    process.exit(1);
  }
  return result.data;
}
