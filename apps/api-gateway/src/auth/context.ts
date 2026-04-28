import type { UserRole } from '@prisma/client';
import type { GatewayAuthContext, GatewayRole } from '../types';
import type { VerifiedPrivyToken } from './privy';

function normalizeRole(role: UserRole): GatewayRole {
  if (role === 'DRIVER' || role === 'BOTH') return role;
  return 'RIDER';
}

interface UserSnapshot {
  id: string;
  privyDid: string;
  walletAddress: string | null;
  role: UserRole;
  name: string | null;
}

interface BuildGatewayAuthContextInput {
  user: UserSnapshot;
  verifiedToken: VerifiedPrivyToken;
  driverId?: string;
}

export function buildGatewayAuthContext(input: BuildGatewayAuthContextInput): GatewayAuthContext {
  return {
    userId: input.user.id,
    privyDid: input.user.privyDid,
    walletAddress: input.user.walletAddress?.toLowerCase(),
    role: normalizeRole(input.user.role),
    driverId: input.driverId,
    name: input.user.name ?? undefined,
    email:
      typeof input.verifiedToken.claims['email'] === 'string'
        ? input.verifiedToken.claims['email']
        : undefined,
  };
}
