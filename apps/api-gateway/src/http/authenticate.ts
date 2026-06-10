import type { IncomingMessage } from 'http';
import { userClient } from '@wheleers/db';
import { verifyLocalAccessToken } from '../auth/local';
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

  if (process.env.JWT_SECRET) {
    try {
      const localToken = verifyLocalAccessToken(token, process.env.JWT_SECRET);
      return await userClient.findById(localToken.sub);
    } catch (error) {
      if (error instanceof Error && error.message.includes('Local auth token')) {
        // Fall through to Privy verification so legacy clients keep working.
      } else {
        throw error;
      }
    }
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
