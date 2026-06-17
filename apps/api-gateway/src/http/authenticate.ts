import type { IncomingMessage } from 'http';
import { userClient } from '@wheleers/db';
import { verifyLocalAccessToken } from '../auth/local';

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
  jwtSecret: string,
): Promise<NonNullable<Awaited<ReturnType<typeof userClient.findByPrivyDid>>>> {
  const authorization =
    typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined;
  const token = extractBearerToken(authorization);

  if (!token) {
    throw new Error('Authorization bearer token is required');
  }

  const localToken = verifyLocalAccessToken(token, jwtSecret);
  return await userClient.findById(localToken.sub);
}
