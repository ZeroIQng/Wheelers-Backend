import { createHash, randomBytes } from 'crypto';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { Redis } from '../redis';

/**
 * Everything the OAuth server needs to remember lives in Redis so the process
 * can restart (pm2) without logging every connected Claude out. Bearer-style
 * secrets (codes, access/refresh tokens) are stored by SHA-256 hash only.
 */

export interface LoginSession {
  clientId: string;
  clientName: string | null;
  state?: string;
  scopes: string[];
  codeChallenge: string;
  redirectUri: string;
  resource?: string;
  createdAt: string;
}

export interface AuthorizationCodeRecord {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  resource?: string;
  userId: string;
  gatewayToken: string;
  gatewayTokenExp: number; // unix seconds
}

export interface AccessTokenRecord {
  clientId: string;
  scopes: string[];
  userId: string;
  gatewayToken: string;
  expiresAt: number; // unix seconds
}

export interface RefreshTokenRecord {
  clientId: string;
  scopes: string[];
  userId: string;
  gatewayToken: string;
  gatewayTokenExp: number;
}

const CLIENT_TTL_S = 60 * 60 * 24 * 90;
const LOGIN_SESSION_TTL_S = 60 * 10;
const AUTH_CODE_TTL_S = 60 * 10;

export function hashSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Gateway access tokens are HS256 JWTs with a numeric `exp`. We cannot verify
 * them (no JWT_SECRET here — by design) but we can read the expiry so refresh
 * tokens never outlive the session they wrap.
 */
export function readJwtExpiry(token: string): number | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { exp?: unknown };
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export class OAuthStore {
  constructor(private readonly redis: Redis) {}

  // ── Clients (dynamic registration) ───────────────────────────────────────

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const raw = await this.redis.get(`mcp:oauth:client:${clientId}`);
    if (!raw) return undefined;
    // Touch so actively used clients never expire.
    await this.redis.expire(`mcp:oauth:client:${clientId}`, CLIENT_TTL_S);
    return JSON.parse(raw) as OAuthClientInformationFull;
  }

  async saveClient(client: OAuthClientInformationFull): Promise<void> {
    await this.redis.set(
      `mcp:oauth:client:${client.client_id}`,
      JSON.stringify(client),
      'EX',
      CLIENT_TTL_S,
    );
  }

  // ── Login sessions (between /authorize and the login form) ───────────────

  async createLoginSession(session: LoginSession): Promise<string> {
    const sid = randomToken(24);
    await this.redis.set(`mcp:oauth:login:${sid}`, JSON.stringify(session), 'EX', LOGIN_SESSION_TTL_S);
    return sid;
  }

  async getLoginSession(sid: string): Promise<LoginSession | null> {
    const raw = await this.redis.get(`mcp:oauth:login:${sid}`);
    return raw ? (JSON.parse(raw) as LoginSession) : null;
  }

  async deleteLoginSession(sid: string): Promise<void> {
    await this.redis.del(`mcp:oauth:login:${sid}`);
  }

  // ── Authorization codes ──────────────────────────────────────────────────

  async createAuthorizationCode(record: AuthorizationCodeRecord): Promise<string> {
    const code = randomToken(32);
    await this.redis.set(`mcp:oauth:code:${hashSecret(code)}`, JSON.stringify(record), 'EX', AUTH_CODE_TTL_S);
    return code;
  }

  async getAuthorizationCode(code: string): Promise<AuthorizationCodeRecord | null> {
    const raw = await this.redis.get(`mcp:oauth:code:${hashSecret(code)}`);
    return raw ? (JSON.parse(raw) as AuthorizationCodeRecord) : null;
  }

  /** Single use: returns the record and deletes it atomically. */
  async consumeAuthorizationCode(code: string): Promise<AuthorizationCodeRecord | null> {
    const key = `mcp:oauth:code:${hashSecret(code)}`;
    const raw = await this.redis.getdel(key);
    return raw ? (JSON.parse(raw) as AuthorizationCodeRecord) : null;
  }

  // ── Access / refresh tokens ──────────────────────────────────────────────

  async issueTokens(input: {
    clientId: string;
    scopes: string[];
    userId: string;
    gatewayToken: string;
    gatewayTokenExp: number;
    accessTtlSeconds: number;
  }): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    const now = nowSeconds();
    const gatewayRemaining = Math.max(0, input.gatewayTokenExp - now);
    const expiresIn = Math.max(60, Math.min(input.accessTtlSeconds, gatewayRemaining));
    const refreshTtl = Math.max(60, gatewayRemaining);

    const accessToken = randomToken(32);
    const refreshToken = randomToken(32);

    const access: AccessTokenRecord = {
      clientId: input.clientId,
      scopes: input.scopes,
      userId: input.userId,
      gatewayToken: input.gatewayToken,
      expiresAt: now + expiresIn,
    };
    const refresh: RefreshTokenRecord = {
      clientId: input.clientId,
      scopes: input.scopes,
      userId: input.userId,
      gatewayToken: input.gatewayToken,
      gatewayTokenExp: input.gatewayTokenExp,
    };

    await this.redis
      .multi()
      .set(`mcp:oauth:access:${hashSecret(accessToken)}`, JSON.stringify(access), 'EX', expiresIn)
      .set(`mcp:oauth:refresh:${hashSecret(refreshToken)}`, JSON.stringify(refresh), 'EX', refreshTtl)
      .exec();

    return { accessToken, refreshToken, expiresIn };
  }

  async getAccessToken(token: string): Promise<AccessTokenRecord | null> {
    const raw = await this.redis.get(`mcp:oauth:access:${hashSecret(token)}`);
    return raw ? (JSON.parse(raw) as AccessTokenRecord) : null;
  }

  async consumeRefreshToken(token: string): Promise<RefreshTokenRecord | null> {
    const raw = await this.redis.getdel(`mcp:oauth:refresh:${hashSecret(token)}`);
    return raw ? (JSON.parse(raw) as RefreshTokenRecord) : null;
  }

  async revoke(token: string): Promise<void> {
    const hash = hashSecret(token);
    await this.redis.del(`mcp:oauth:access:${hash}`, `mcp:oauth:refresh:${hash}`);
  }

  // ── Cache for raw gateway tokens used directly as bearers ────────────────

  async getCachedGatewayUser(token: string): Promise<string | null> {
    return this.redis.get(`mcp:oauth:gwtoken:${hashSecret(token)}`);
  }

  async cacheGatewayUser(token: string, userId: string, ttlSeconds: number): Promise<void> {
    await this.redis.set(`mcp:oauth:gwtoken:${hashSecret(token)}`, userId, 'EX', ttlSeconds);
  }
}
