import { z } from 'zod';

const ComplianceEnvSchema = z.object({
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
