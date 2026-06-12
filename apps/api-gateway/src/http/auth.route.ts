import type { IncomingMessage, ServerResponse } from 'http';
import { randomUUID } from 'crypto';
import {
  UserCreatedEvent,
  UserRoleChangedEvent,
  UserWalletLinkedEvent,
} from '@wheleers/kafka-schemas';
import { UserRole, userClient } from '@wheleers/db';
import { createLocalAccessToken, hashPassword, verifyPassword } from '../auth/local';
import { verifyPrivyAccessToken } from '../auth/privy';
import type { GatewayRole } from '../types';
import { getString, isRecord } from '../utils/object';
import type { GatewayPublisher } from '../websocket/publisher';
import { readJsonBody, sendJson } from './utils';

interface AuthRouteDeps {
  privyAppId: string;
  privyVerificationKey: string;
  jwtSecret?: string;
  publisher: GatewayPublisher;
}

const ROLE_MAP: Record<GatewayRole, UserRole> = {
  RIDER: UserRole.RIDER,
  DRIVER: UserRole.DRIVER,
  BOTH: UserRole.BOTH,
};

const JWT_SECRET_CONFIG_ERROR =
  'JWT_SECRET must be set to at least 32 characters for username/password auth.';

function parseRole(value: unknown): GatewayRole | undefined {
  if (value === 'RIDER' || value === 'DRIVER' || value === 'BOTH') {
    return value;
  }

  return undefined;
}

function normalizeAuthMethod(value: unknown): 'email' | 'google' | 'apple' | 'wallet' | 'username' {
  if (value === 'username') {
    return value;
  }
  if (value === 'email' || value === 'google' || value === 'apple') {
    return value;
  }
  return 'wallet';
}

function normalizeWalletAddress(value: string | undefined): string | undefined {
  const trimmed = value?.trim().toLowerCase();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function requireJwtSecret(value: string | undefined): string {
  if (!value || value.length < 32) {
    throw new Error(JWT_SECRET_CONFIG_ERROR);
  }

  return value;
}

function isJwtSecretConfigError(error: unknown): boolean {
  return error instanceof Error && error.message === JWT_SECRET_CONFIG_ERROR;
}

function normalizeUsername(value: string | undefined): string {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed) {
    throw new Error('username is required');
  }

  if (!/^[a-z0-9_]{3,24}$/.test(trimmed)) {
    throw new Error(
      'username must be 3-24 characters and use only lowercase letters, numbers, or underscores.',
    );
  }

  return trimmed;
}

function normalizePassword(value: string | undefined): string {
  if (!value) {
    throw new Error('password is required');
  }

  if (value.length < 8 || value.length > 128) {
    throw new Error('password must be between 8 and 128 characters.');
  }

  return value;
}

function normalizeEmail(value: string | undefined): string | undefined {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed) {
    return undefined;
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    throw new Error('email must be a valid email address.');
  }

  return trimmed;
}

function normalizeName(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  if (trimmed.length < 2 || trimmed.length > 80) {
    throw new Error('fullName must be between 2 and 80 characters.');
  }

  return trimmed;
}

function serializeUser(user: {
  id: string;
  privyDid: string;
  walletAddress: string | null;
  username?: string | null;
  email: string | null;
  role: UserRole;
  name: string | null;
  phone: string | null;
}): Record<string, unknown> {
  return {
    id: user.id,
    privyDid: user.privyDid,
    walletAddress: user.walletAddress,
    username: user.username ?? null,
    email: user.email,
    role: user.role,
    name: user.name,
    phone: user.phone,
  };
}

export async function handlePrivyAuthRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AuthRouteDeps,
): Promise<void> {
  try {
    const rawBody = await readJsonBody(req);
    if (!isRecord(rawBody)) {
      sendJson(res, 400, { error: 'Body must be a JSON object' });
      return;
    }

    const token =
      getString(rawBody, 'accessToken') ??
      getString(rawBody, 'token') ??
      extractBearerToken(
        typeof req.headers.authorization === 'string'
          ? req.headers.authorization
          : undefined,
      );

    if (!token) {
      sendJson(res, 400, { error: 'accessToken is required' });
      return;
    }

    const verifiedToken = verifyPrivyAccessToken({
      accessToken: token,
      appId: deps.privyAppId,
      verificationKey: deps.privyVerificationKey,
    });

    const privyDid = verifiedToken.privyDid;

    const walletAddress = normalizeWalletAddress(
      getString(rawBody, 'walletAddress') ??
      (typeof verifiedToken.claims['walletAddress'] === 'string'
        ? verifiedToken.claims['walletAddress']
        : undefined),
    );

    const email =
      getString(rawBody, 'email') ??
      (typeof verifiedToken.claims['email'] === 'string'
        ? verifiedToken.claims['email']
        : undefined);

    const name =
      getString(rawBody, 'name') ??
      (typeof verifiedToken.claims['name'] === 'string'
        ? verifiedToken.claims['name']
        : undefined);

    const phone = getString(rawBody, 'phone');

    const requestedRole = parseRole(
      getString(rawBody, 'role') ??
      (typeof verifiedToken.claims['role'] === 'string'
        ? verifiedToken.claims['role']
        : undefined),
    );

    const existing = await userClient.findByPrivyDid(privyDid);

    if (existing) {
      let user = existing;
      const shouldLinkWallet = !existing.walletAddress && Boolean(walletAddress);
      const shouldUpdateIdentity =
        shouldLinkWallet ||
        (email !== undefined && email !== existing.email) ||
        (name !== undefined && name !== existing.name) ||
        (phone !== undefined && phone !== existing.phone);

      if (shouldUpdateIdentity) {
        user = await userClient.updateAuthIdentity(existing.id, {
          walletAddress: shouldLinkWallet ? walletAddress : undefined,
          email,
          name,
          phone,
        });
      }

      if (shouldLinkWallet && walletAddress) {
        const walletLinkedEvent = UserWalletLinkedEvent.parse({
          eventType: 'USER_WALLET_LINKED',
          userId: user.id,
          privyDid: user.privyDid,
          walletAddress,
          timestamp: new Date().toISOString(),
        });

        await deps.publisher.publishUserEvent(walletLinkedEvent);
      }

      if (requestedRole && existing.role !== ROLE_MAP[requestedRole]) {
        await userClient.updateRole(existing.id, ROLE_MAP[requestedRole]);

        const roleChangedEvent = UserRoleChangedEvent.parse({
          eventType: 'USER_ROLE_CHANGED',
          userId: existing.id,
          previousRole: existing.role,
          newRole: ROLE_MAP[requestedRole],
          timestamp: new Date().toISOString(),
        });

        await deps.publisher.publishUserEvent(roleChangedEvent);
      }

      sendJson(res, 200, {
        created: false,
        user: serializeUser({
          ...user,
          role:
            requestedRole && existing.role !== ROLE_MAP[requestedRole]
              ? ROLE_MAP[requestedRole]
              : user.role,
        }),
      });
      return;
    }

    const role = requestedRole ?? 'RIDER';

    const created = await userClient.create({
      privyDid,
      walletAddress,
      email,
      role: ROLE_MAP[role],
      name,
      phone,
    });

    const event = UserCreatedEvent.parse({
      eventType: 'USER_CREATED',
      userId: created.id,
      privyDid: created.privyDid,
      walletAddress: created.walletAddress ?? undefined,
      role: ROLE_MAP[role],
      email: created.email ?? undefined,
      name: created.name ?? undefined,
      authMethod: normalizeAuthMethod(
        getString(rawBody, 'authMethod') ??
        (typeof verifiedToken.claims['authMethod'] === 'string'
          ? verifiedToken.claims['authMethod']
          : undefined),
      ),
      timestamp: new Date().toISOString(),
    });

    await deps.publisher.publishUserEvent(event);

    sendJson(res, 201, {
      created: true,
      user: serializeUser(created),
    });

  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const isInternalCryptoError =
      message.includes('DECODER') ||
      message.includes('error:') ||
      message.includes('unsupported');
    sendJson(res, 401, {
      error: isInternalCryptoError ? 'Privy auth failed' : (message || 'Privy auth failed'),
    });
  }
}

export async function handleUsernamePasswordSignupRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AuthRouteDeps,
): Promise<void> {
  try {
    const rawBody = await readJsonBody(req);
    if (!isRecord(rawBody)) {
      sendJson(res, 400, { error: 'Body must be a JSON object' });
      return;
    }

    const username = normalizeUsername(getString(rawBody, 'username'));
    const password = normalizePassword(getString(rawBody, 'password'));
    const jwtSecret = requireJwtSecret(deps.jwtSecret);
    const email = normalizeEmail(getString(rawBody, 'email'));
    const name = normalizeName(getString(rawBody, 'fullName') ?? getString(rawBody, 'name'));
    const phone = getString(rawBody, 'phone')?.trim() || undefined;
    const requestedRole = parseRole(getString(rawBody, 'role'));
    const role = requestedRole ?? 'RIDER';

    const existing = await userClient.findByUsername(username);
    if (existing) {
      sendJson(res, 409, { error: 'That username is already taken.' });
      return;
    }

    const passwordHash = await hashPassword(password);
    const created = await userClient.create({
      privyDid: `local:${randomUUID()}`,
      username,
      passwordHash,
      email,
      role: ROLE_MAP[role],
      name,
      phone,
    });

    const event = UserCreatedEvent.parse({
      eventType: 'USER_CREATED',
      userId: created.id,
      privyDid: created.privyDid,
      walletAddress: created.walletAddress ?? undefined,
      role: ROLE_MAP[role],
      email: created.email ?? undefined,
      name: created.name ?? undefined,
      authMethod: 'username',
      timestamp: new Date().toISOString(),
    });

    await deps.publisher.publishUserEvent(event);

    sendJson(res, 201, {
      created: true,
      accessToken: createLocalAccessToken(created.id, jwtSecret),
      tokenType: 'Bearer',
      user: serializeUser(created),
    });
  } catch (error) {
    if (isJwtSecretConfigError(error)) {
      console.error('[auth] username/password signup is not configured:', error);
      sendJson(res, 500, {
        error: 'Username/password auth is not configured on this server.',
      });
      return;
    }

    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'P2002'
    ) {
      sendJson(res, 409, { error: 'That username is already taken.' });
      return;
    }

    sendJson(res, 400, {
      error: error instanceof Error ? error.message : 'Signup failed',
    });
  }
}

export async function handleUsernamePasswordSigninRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: Pick<AuthRouteDeps, 'jwtSecret'>,
): Promise<void> {
  try {
    const rawBody = await readJsonBody(req);
    if (!isRecord(rawBody)) {
      sendJson(res, 400, { error: 'Body must be a JSON object' });
      return;
    }

    const username = normalizeUsername(getString(rawBody, 'username'));
    const password = normalizePassword(getString(rawBody, 'password'));
    const jwtSecret = requireJwtSecret(deps.jwtSecret);
    const user = await userClient.findByUsername(username);

    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      sendJson(res, 401, { error: 'Invalid username or password.' });
      return;
    }

    sendJson(res, 200, {
      accessToken: createLocalAccessToken(user.id, jwtSecret),
      tokenType: 'Bearer',
      user: serializeUser(user),
    });
  } catch (error) {
    if (isJwtSecretConfigError(error)) {
      console.error('[auth] username/password signin is not configured:', error);
      sendJson(res, 500, {
        error: 'Username/password auth is not configured on this server.',
      });
      return;
    }

    sendJson(res, 400, {
      error: error instanceof Error ? error.message : 'Signin failed',
    });
  }
}

function extractBearerToken(value: string | undefined): string | undefined {
  if (!value) return undefined;

  const [scheme, token] = value.split(' ');
  if (!scheme || !token) return undefined;

  if (scheme.toLowerCase() !== 'bearer') return undefined;
  return token;
}
