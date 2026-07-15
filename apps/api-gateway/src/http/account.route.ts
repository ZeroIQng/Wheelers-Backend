import type { IncomingMessage, ServerResponse } from 'http';
import { userClient } from '@wheleers/db';
import { authenticateHttpUser } from './authenticate';
import { sendJson } from './utils';
import type { RedisClient } from '../redis/client';

/**
 * Token blacklist: prefix + jti (token signature) stored in Redis
 * with TTL matching the token's remaining lifetime.
 */
const BLACKLIST_PREFIX = 'auth:blacklist:';

// Max token TTL is 30 days (from auth/local.ts TOKEN_TTL_SECONDS)
const MAX_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;

function extractTokenSignature(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const [, token] = authorization.split(' ');
  if (!token) return null;
  // The signature is the last segment of the JWT
  const parts = token.split('.');
  return parts.length === 3 ? parts[2]! : null;
}

interface AccountRouteDeps {
  jwtSecret: string;
  redisClient: RedisClient;
}

/**
 * POST /auth/logout
 *
 * Blacklists the current token so it cannot be reused.
 * The frontend already clears the local token — this prevents
 * anyone who intercepted the token from using it after logout.
 */
export async function handleLogoutRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AccountRouteDeps,
): Promise<void> {
  try {
    // Authenticate to confirm this is a valid token
    await authenticateHttpUser(req, deps.jwtSecret);

    // Blacklist the token signature in Redis
    const sig = extractTokenSignature(
      typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined,
    );

    if (sig) {
      const key = `${BLACKLIST_PREFIX}${sig}`;
      await deps.redisClient.set(key, '1', MAX_TOKEN_TTL_SECONDS);
    }

    sendJson(res, 200, { success: true });
  } catch (error) {
    sendJson(res, 401, {
      error: error instanceof Error ? error.message : 'Logout failed',
    });
  }
}

/**
 * POST /auth/delete-account
 *
 * Soft-deletes the authenticated user's account:
 * - Anonymizes all PII (name, email, phone, etc.)
 * - Clears auth credentials (password hash)
 * - Disables notification devices
 * - Revokes consents
 * - Blacklists the current token
 *
 * The user row is kept for referential integrity with rides, wallets, etc.
 */
export async function handleDeleteAccountRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AccountRouteDeps,
): Promise<void> {
  try {
    const user = await authenticateHttpUser(req, deps.jwtSecret);

    // Soft-delete: anonymize PII and disable everything
    await userClient.softDelete(user.id);

    // Blacklist the current token
    const sig = extractTokenSignature(
      typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined,
    );

    if (sig) {
      const key = `${BLACKLIST_PREFIX}${sig}`;
      await deps.redisClient.set(key, '1', MAX_TOKEN_TTL_SECONDS);
    }

    console.info('[account] account deleted', { userId: user.id });

    sendJson(res, 200, { deleted: true });
  } catch (error) {
    sendJson(res, 400, {
      error: error instanceof Error ? error.message : 'Could not delete account',
    });
  }
}

/**
 * Check if a token signature is blacklisted.
 * Call this from authenticateHttpUser or middleware to reject revoked tokens.
 */
export async function isTokenBlacklisted(
  redisClient: RedisClient,
  authorization: string | undefined,
): Promise<boolean> {
  const sig = extractTokenSignature(authorization);
  if (!sig) return false;

  const result = await redisClient.get(`${BLACKLIST_PREFIX}${sig}`);
  return result !== null;
}
