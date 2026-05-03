import type { IncomingMessage } from 'http';
import { userClient } from '@wheleers/db';
import { verifyPrivyAccessToken } from '../auth/privy';

export function extractBearerToken(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const [scheme, token] = value.split(' ');
  if (!scheme || !token || scheme.toLowerCase() !== 'bearer') {
    return undefined;
  }

  return token;
}

export async function authenticateHttpUser(
  req: IncomingMessage,
  appId: string,
  verificationKey: string,
): Promise<NonNullable<Awaited<ReturnType<typeof userClient.findByPrivyDid>>>> {
  const authorization =
    typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined;
  const token = extractBearerToken(authorization);

  if (!token) {
    throw new Error('Authorization bearer token is required');
  }

  const verifiedToken = verifyPrivyAccessToken({
    accessToken: token,
    appId,
    verificationKey,
  });

  const user = await userClient.findByPrivyDid(verifiedToken.privyDid);
  if (!user) {
    throw new Error('User not registered. Call POST /auth/privy first.');
  }

  return user;
}
