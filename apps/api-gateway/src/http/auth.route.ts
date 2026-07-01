import type { IncomingMessage, ServerResponse } from 'http';
import { randomUUID } from 'crypto';
import {
  UserCreatedEvent,
  UserRoleChangedEvent,
} from '@wheleers/kafka-schemas';
import { UserRole, userClient, walletClient } from '@wheleers/db';
import { createLocalAccessToken, hashPassword, verifyPassword } from '../auth/local';
import type { GatewayRole } from '../types';
import { getString, isRecord } from '../utils/object';
import type { GatewayPublisher } from '../websocket/publisher';
import type { PouchLiquifiaClient } from '@wheleers/pouch-client';
import { readJsonBody, sendJson } from './utils';
import { provisionPouchAccount } from '../onboarding/user-onboarding';

interface AuthRouteDeps {
  jwtSecret: string;
  publisher: GatewayPublisher;
  pouchLiquifiaClient: PouchLiquifiaClient;
}

const ROLE_MAP: Record<GatewayRole, UserRole> = {
  RIDER: UserRole.RIDER,
  DRIVER: UserRole.DRIVER,
  BOTH: UserRole.BOTH,
};

function parseRole(value: unknown): GatewayRole | undefined {
  if (value === 'RIDER' || value === 'DRIVER' || value === 'BOTH') {
    return value;
  }

  return undefined;
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
  username?: string | null;
  email: string | null;
  role: UserRole;
  name: string | null;
  phone: string | null;
}): Record<string, unknown> {
  return {
    id: user.id,
    privyDid: user.privyDid,
    username: user.username ?? null,
    email: user.email,
    role: user.role,
    name: user.name,
    phone: user.phone,
  };
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
      role: ROLE_MAP[role],
      email: created.email ?? undefined,
      name: created.name ?? undefined,
      authMethod: 'username',
      timestamp: new Date().toISOString(),
    });

    await deps.publisher.publishUserEvent(event);

    // Create wallet + Pouch virtual account in the background.
    // Signup succeeds even if Pouch provisioning fails — user can retry later.
    await walletClient.create(created.id).catch((walletError) => {
      console.warn('[auth] wallet creation failed', {
        userId: created.id,
        error: walletError instanceof Error ? walletError.message : String(walletError),
      });
    });

    void provisionPouchAccount(deps.pouchLiquifiaClient, created.id, name).catch(
      (provisionError) => {
        console.warn('[auth] pouch provisioning failed (non-blocking)', {
          userId: created.id,
          error:
            provisionError instanceof Error
              ? provisionError.message
              : String(provisionError),
        });
      },
    );

    sendJson(res, 201, {
      created: true,
      accessToken: createLocalAccessToken(created.id, deps.jwtSecret),
      tokenType: 'Bearer',
      user: serializeUser(created),
    });
  } catch (error) {
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
    const user = await userClient.findByUsername(username);

    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      sendJson(res, 401, { error: 'Invalid username or password.' });
      return;
    }

    sendJson(res, 200, {
      accessToken: createLocalAccessToken(user.id, deps.jwtSecret),
      tokenType: 'Bearer',
      user: {
        ...serializeUser(user),
        phone: user.phone || user.email || user.privyDid,
      },
    });
  } catch (error) {
    sendJson(res, 400, {
      error: error instanceof Error ? error.message : 'Signin failed',
    });
  }
}
