import type { IncomingMessage, ServerResponse } from 'http';
import { createPublicKey, createVerify } from 'crypto';
import { UserRole, userClient, driverClient, walletClient } from '@wheleers/db';
import type { PouchLiquifiaClient } from '@wheleers/pouch-client';
import { createLocalAccessToken } from '../auth/local';
import { provisionPouchAccount } from '../onboarding/user-onboarding';
import { isRecord, getString } from '../utils/object';
import { readJsonBody, sendJson } from './utils';

interface SocialAuthDeps {
  jwtSecret: string;
  appleBundleId?: string;
  googleClientId?: string;
  pouchLiquifiaClient?: PouchLiquifiaClient;
}

// ------------------------------------------------------------------
// Lightweight JWT helpers (no external dep — only need RS256 verify)
// ------------------------------------------------------------------

interface JwtHeader {
  alg: string;
  kid?: string;
}

interface JwtPayload {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  exp?: number;
  iat?: number;
  email?: string;
  name?: string;
  email_verified?: boolean;
}

function base64UrlDecode(value: string): Buffer {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + padding, 'base64');
}

function decodeJwt(token: string): { header: JwtHeader; payload: JwtPayload; signedPart: string; signature: Buffer } {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid JWT format');

  const header = JSON.parse(base64UrlDecode(parts[0]!).toString('utf8')) as JwtHeader;
  const payload = JSON.parse(base64UrlDecode(parts[1]!).toString('utf8')) as JwtPayload;
  const signedPart = `${parts[0]}.${parts[1]}`;
  const signature = base64UrlDecode(parts[2]!);

  return { header, payload, signedPart, signature };
}

// ------------------------------------------------------------------
// JWKS cache (fetches public keys from Apple/Google)
// ------------------------------------------------------------------

interface JwkKey {
  kty: string;
  kid: string;
  use?: string;
  alg?: string;
  n?: string;
  e?: string;
  x?: string;
  y?: string;
  crv?: string;
}

const jwksCache = new Map<string, { keys: JwkKey[]; fetchedAt: number }>();
const JWKS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

async function fetchJwks(url: string): Promise<JwkKey[]> {
  const cached = jwksCache.get(url);
  if (cached && Date.now() - cached.fetchedAt < JWKS_CACHE_TTL_MS) {
    return cached.keys;
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch JWKS from ${url}: ${response.status}`);
  }

  const body = await response.json() as { keys: JwkKey[] };
  const keys = body.keys ?? [];
  jwksCache.set(url, { keys, fetchedAt: Date.now() });
  return keys;
}

function verifyRsaSignature(signedPart: string, signature: Buffer, jwk: JwkKey): boolean {
  const keyObject = createPublicKey({ key: jwk, format: 'jwk' });
  const verifier = createVerify('RSA-SHA256');
  verifier.update(signedPart);
  return verifier.verify(keyObject, signature);
}

// ------------------------------------------------------------------
// Apple ID Token Verification
// ------------------------------------------------------------------

const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys';

async function verifyAppleToken(idToken: string, bundleId: string): Promise<{ sub: string; email?: string; name?: string }> {
  const { header, payload, signedPart, signature } = decodeJwt(idToken);

  if (header.alg !== 'RS256') {
    throw new Error('Unsupported Apple token algorithm');
  }

  // Verify issuer
  if (payload.iss !== 'https://appleid.apple.com') {
    throw new Error('Invalid Apple token issuer');
  }

  // Verify audience
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(bundleId)) {
    throw new Error('Invalid Apple token audience');
  }

  // Verify expiry
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error('Apple token expired');
  }

  // Verify signature with JWKS
  const keys = await fetchJwks(APPLE_JWKS_URL);
  const key = keys.find((k) => k.kid === header.kid);
  if (!key) {
    throw new Error('Apple signing key not found');
  }

  if (!verifyRsaSignature(signedPart, signature, key)) {
    throw new Error('Apple token signature verification failed');
  }

  if (!payload.sub) {
    throw new Error('Apple token missing subject');
  }

  return {
    sub: payload.sub,
    email: payload.email,
    name: undefined, // Apple sends name only on first auth — handled by client
  };
}

// ------------------------------------------------------------------
// Google ID Token Verification
// ------------------------------------------------------------------

const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

async function verifyGoogleToken(idToken: string, clientId: string): Promise<{ sub: string; email?: string; name?: string }> {
  const { header, payload, signedPart, signature } = decodeJwt(idToken);

  if (header.alg !== 'RS256') {
    throw new Error('Unsupported Google token algorithm');
  }

  // Verify issuer
  if (!payload.iss || !GOOGLE_ISSUERS.includes(payload.iss)) {
    throw new Error('Invalid Google token issuer');
  }

  // Verify audience
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(clientId)) {
    throw new Error('Invalid Google token audience');
  }

  // Verify expiry
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error('Google token expired');
  }

  // Verify signature with JWKS
  const keys = await fetchJwks(GOOGLE_JWKS_URL);
  const key = keys.find((k) => k.kid === header.kid);
  if (!key) {
    throw new Error('Google signing key not found');
  }

  if (!verifyRsaSignature(signedPart, signature, key)) {
    throw new Error('Google token signature verification failed');
  }

  if (!payload.sub) {
    throw new Error('Google token missing subject');
  }

  return {
    sub: payload.sub,
    email: payload.email,
    name: payload.name,
  };
}

// ------------------------------------------------------------------
// Shared: find-or-create user + driver record
// ------------------------------------------------------------------

async function findOrCreateDriverUser(
  provider: 'apple' | 'google',
  sub: string,
  email?: string,
  name?: string,
  jwtSecret?: string,
  pouchLiquifiaClient?: PouchLiquifiaClient,
): Promise<{ accessToken: string; user: Record<string, unknown>; isNewUser: boolean }> {
  const privyDid = `${provider}:${sub}`;

  const existing = await userClient.findByPrivyDid(privyDid);
  let isNewUser = false;
  let userId: string;
  let userRecord: { id: string; privyDid: string; email: string | null; role: UserRole; name: string | null; phone: string | null };

  if (existing) {
    userId = existing.id;
    userRecord = existing;
  } else {
    // Create user with DRIVER role
    const created = await userClient.create({
      privyDid,
      email: email ?? undefined,
      role: UserRole.DRIVER,
      name: name ?? undefined,
    });
    userId = created.id;
    userRecord = created;
    isNewUser = true;

    // Create Driver record
    await driverClient.create(userId);

    // Create fiat wallet
    await walletClient.create(userId).catch((error) => {
      console.warn('[social-auth] wallet creation failed (non-blocking)', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  // Provision virtual account in background (for both new and existing users)
  if (pouchLiquifiaClient) {
    void provisionPouchAccount(
      pouchLiquifiaClient,
      userId,
      name ?? userRecord.name ?? undefined,
    ).catch((error) => {
      const errorDetail = error instanceof Error
        ? { message: error.message, name: error.name, ...(error as any).status && { status: (error as any).status } }
        : error;
      console.warn('[social-auth] pouch provisioning failed (non-blocking)', {
        userId,
        error: JSON.stringify(errorDetail),
      });
    });
  }

  const accessToken = createLocalAccessToken(userId, jwtSecret);

  return {
    accessToken,
    user: {
      id: userRecord.id,
      privyDid: userRecord.privyDid,
      email: userRecord.email,
      role: userRecord.role,
      name: userRecord.name,
      phone: userRecord.phone,
      isNewUser,
    },
    isNewUser,
  };
}

// ------------------------------------------------------------------
// Route Handlers
// ------------------------------------------------------------------

export async function handleAppleAuthRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: SocialAuthDeps,
): Promise<void> {
  try {
    const rawBody = await readJsonBody(req);
    if (!isRecord(rawBody)) {
      sendJson(res, 400, { error: 'Body must be a JSON object' });
      return;
    }

    const idToken = getString(rawBody, 'idToken');
    const clientName = getString(rawBody, 'name'); // Apple sends name from client on first auth

    if (!idToken) {
      sendJson(res, 400, { error: 'idToken is required' });
      return;
    }

    if (!deps.appleBundleId) {
      sendJson(res, 500, { error: 'Apple auth not configured' });
      return;
    }

    const verified = await verifyAppleToken(idToken, deps.appleBundleId);
    const result = await findOrCreateDriverUser(
      'apple',
      verified.sub,
      verified.email,
      clientName ?? verified.name,
      deps.jwtSecret,
      deps.pouchLiquifiaClient,
    );

    sendJson(res, 200, {
      accessToken: result.accessToken,
      tokenType: 'Bearer',
      user: result.user,
    });
  } catch (error) {
    console.warn('[auth/apple] verification failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    sendJson(res, 401, {
      error: error instanceof Error ? error.message : 'Apple authentication failed',
    });
  }
}

export async function handleGoogleAuthRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: SocialAuthDeps,
): Promise<void> {
  try {
    const rawBody = await readJsonBody(req);
    if (!isRecord(rawBody)) {
      sendJson(res, 400, { error: 'Body must be a JSON object' });
      return;
    }

    const idToken = getString(rawBody, 'idToken');

    if (!idToken) {
      sendJson(res, 400, { error: 'idToken is required' });
      return;
    }

    if (!deps.googleClientId) {
      sendJson(res, 500, { error: 'Google auth not configured' });
      return;
    }

    const verified = await verifyGoogleToken(idToken, deps.googleClientId);
    const result = await findOrCreateDriverUser(
      'google',
      verified.sub,
      verified.email,
      verified.name,
      deps.jwtSecret,
      deps.pouchLiquifiaClient,
    );

    sendJson(res, 200, {
      accessToken: result.accessToken,
      tokenType: 'Bearer',
      user: result.user,
    });
  } catch (error) {
    console.warn('[auth/google] verification failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    sendJson(res, 401, {
      error: error instanceof Error ? error.message : 'Google authentication failed',
    });
  }
}
