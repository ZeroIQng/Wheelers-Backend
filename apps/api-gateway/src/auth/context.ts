import type { UserRole } from '@prisma/client';
import type { GatewayAuthContext, GatewayRole } from '../types';

function normalizeRole(role: UserRole): GatewayRole {
  if (role === 'DRIVER' || role === 'BOTH') return role;
  return 'RIDER';
}

interface UserSnapshot {
  id: string;
  privyDid: string;
  role: UserRole;
  name: string | null;
  email: string | null;
}

interface BuildGatewayAuthContextInput {
  user: UserSnapshot;
  driverId?: string;
}

export function buildGatewayAuthContext(input: BuildGatewayAuthContextInput): GatewayAuthContext {
  return {
    userId: input.user.id,
    privyDid: input.user.privyDid,
    role: normalizeRole(input.user.role),
    driverId: input.driverId,
    name: input.user.name ?? undefined,
    email: input.user.email ?? undefined,
  };
}
