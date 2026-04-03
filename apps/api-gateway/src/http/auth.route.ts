import type { IncomingMessage, ServerResponse } from 'http';
import { UserCreatedEvent, UserRoleChangedEvent } from '@wheleers/kafka-schemas';
import { UserRole, userClient } from '@wheleers/db';
import { verifyPrivyAccessToken } from '../auth/privy';
import type { GatewayRole } from '../types';
import { getString, isRecord } from '../utils/object';
import type { GatewayPublisher } from '../websocket/publisher';
import { readJsonBody, sendJson } from './utils';

interface AuthRouteDeps {
  privyAppId: string;
  privyVerificationKey: string;
  publisher: GatewayPublisher;
}

const ROLE_MAP: Record<GatewayRole, UserRole> = {
  RIDER: UserRole.RIDER,
  DRIVER: UserRole.DRIVER,
  BOTH: UserRole.BOTH,
};

function normalizeRole(value: unknown): GatewayRole {
  if (value === 'DRIVER' || value === 'BOTH') return value;
  return 'RIDER';
}

function normalizeAuthMethod(value: unknown): 'email' | 'google' | 'apple' | 'wallet' {
  if (value === 'email' || value === 'google' || value === 'apple') {
    return value;
  }
  return 'wallet';
}

function serializeUser(user: {
  id: string;
  privyDid: string;
  walletAddress: string;
  role: UserRole;
  name: string | null;
  phone: string | null;
}): Record<string, unknown> {
  return {
    id: user.id,
    privyDid: user.privyDid,
    walletAddress: user.walletAddress,
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

    const walletAddress =
      getString(rawBody, 'walletAddress') ??
      (typeof verifiedToken.claims['walletAddress'] === 'string'
        ? verifiedToken.claims['walletAddress']
        : undefined);

    const role = normalizeRole(
      getString(rawBody, 'role') ??
      (typeof verifiedToken.claims['role'] === 'string'
        ? verifiedToken.claims['role']
        : undefined) ??
      'RIDER',
    );

    const existing = await userClient.findByPrivyDid(privyDid);

    if (existing) {
      if (existing.role !== ROLE_MAP[role]) {
        await userClient.updateRole(existing.id, ROLE_MAP[role]);

        const roleChangedEvent = UserRoleChangedEvent.parse({
          eventType: 'USER_ROLE_CHANGED',
          userId: existing.id,
          previousRole: existing.role,
          newRole: ROLE_MAP[role],
          timestamp: new Date().toISOString(),
        });

        await deps.publisher.publishUserEvent(roleChangedEvent);
      }

      sendJson(res, 200, {
        created: false,
        user: serializeUser(existing),
      });
      return;
    }

    if (!walletAddress) {
      sendJson(res, 400, { error: 'walletAddress is required for first-time registration' });
      return;
    }

    const created = await userClient.create({
      privyDid,
      walletAddress,
      role: ROLE_MAP[role],
      name:
        getString(rawBody, 'name') ??
        (typeof verifiedToken.claims['name'] === 'string'
          ? verifiedToken.claims['name']
          : undefined),
      phone: getString(rawBody, 'phone'),
    });

    const event = UserCreatedEvent.parse({
      eventType: 'USER_CREATED',
      userId: created.id,
      privyDid: created.privyDid,
      walletAddress: created.walletAddress,
      role: ROLE_MAP[role],
      email:
        getString(rawBody, 'email') ??
        (typeof verifiedToken.claims['email'] === 'string'
          ? verifiedToken.claims['email']
          : undefined),
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
    sendJson(res, 401, {
      error: error instanceof Error ? error.message : 'Privy auth failed',
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
