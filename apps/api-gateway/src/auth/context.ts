import type { GatewayAuthContext, GatewayRole } from '../types';
import type { JwtClaims } from './jwt';

const ROLES: GatewayRole[] = ['RIDER', 'DRIVER', 'BOTH'];

function parseRole(value: unknown): GatewayRole {
  if (typeof value === 'string' && ROLES.includes(value as GatewayRole)) {
    return value as GatewayRole;
  }
  return 'RIDER';
}

function readString(values: Array<unknown>): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

export function buildGatewayAuthContext(claims: JwtClaims, params: URLSearchParams): GatewayAuthContext {
  const userId = readString([claims['userId'], claims['uid'], params.get('userId')]);
  const privyDid = readString([claims['privyDid'], claims['sub'], params.get('privyDid')]);
  const walletAddress = readString([claims['walletAddress'], params.get('walletAddress')]);

  if (!userId || !privyDid || !walletAddress) {
    throw new Error('JWT is missing required user claims');
  }

  const context: GatewayAuthContext = {
    userId,
    privyDid,
    walletAddress: walletAddress.toLowerCase(),
    role: parseRole(readString([claims['role'], params.get('role')]) ?? 'RIDER'),
    driverId: readString([claims['driverId'], params.get('driverId')]),
    email: readString([claims['email']]),
    name: readString([claims['name']]),
  };

  return context;
}
