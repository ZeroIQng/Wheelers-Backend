import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'crypto';
import { promisify } from 'util';
import { isRecord } from '../utils/object';

const scrypt = promisify(scryptCallback);
const TOKEN_TYPE = 'wheelers.local.auth';
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;

interface LocalTokenPayload {
  sub: string;
  typ: typeof TOKEN_TYPE;
  iat: number;
  exp: number;
}

function base64UrlEncode(value: Buffer | string): string {
  return Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64UrlDecode(value: string): Buffer {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + padding, 'base64');
}

function sign(input: string, secret: string): string {
  return base64UrlEncode(createHmac('sha256', secret).update(input).digest());
}

function requireSecret(secret: string | undefined): string {
  if (!secret || secret.length < 32) {
    throw new Error('JWT_SECRET must be set to at least 32 characters for username/password auth.');
  }

  return secret;
}

function parsePayload(value: unknown): LocalTokenPayload {
  if (!isRecord(value)) {
    throw new Error('Invalid local auth token payload.');
  }

  const { sub, typ, iat, exp } = value;
  if (typeof sub !== 'string' || sub.length === 0) {
    throw new Error('Local auth token is missing subject.');
  }
  if (typ !== TOKEN_TYPE) {
    throw new Error('Local auth token type is invalid.');
  }
  if (typeof iat !== 'number' || typeof exp !== 'number') {
    throw new Error('Local auth token expiry is invalid.');
  }

  return { sub, typ, iat, exp };
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('base64url');
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt$${salt}$${derived.toString('base64url')}`;
}

export async function verifyPassword(password: string, storedHash: string | null | undefined): Promise<boolean> {
  if (!storedHash) {
    return false;
  }

  const [scheme, salt, expectedHash] = storedHash.split('$');
  if (scheme !== 'scrypt' || !salt || !expectedHash) {
    return false;
  }

  const expected = Buffer.from(expectedHash, 'base64url');
  const actual = (await scrypt(password, salt, expected.length)) as Buffer;
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function createLocalAccessToken(userId: string, jwtSecret: string | undefined): string {
  const secret = requireSecret(jwtSecret);
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64UrlEncode(JSON.stringify({
    sub: userId,
    typ: TOKEN_TYPE,
    iat: now,
    exp: now + TOKEN_TTL_SECONDS,
  } satisfies LocalTokenPayload));
  const unsigned = `${header}.${payload}`;

  return `${unsigned}.${sign(unsigned, secret)}`;
}

export function verifyLocalAccessToken(token: string, jwtSecret: string | undefined): LocalTokenPayload {
  const secret = requireSecret(jwtSecret);
  const [header, payload, signature] = token.split('.');
  if (!header || !payload || !signature) {
    throw new Error('Invalid local auth token format.');
  }

  const unsigned = `${header}.${payload}`;
  const expected = sign(unsigned, secret);
  const expectedBuffer = Buffer.from(expected);
  const signatureBuffer = Buffer.from(signature);
  if (
    expectedBuffer.length !== signatureBuffer.length ||
    !timingSafeEqual(expectedBuffer, signatureBuffer)
  ) {
    throw new Error('Local auth token signature verification failed.');
  }

  const parsed = parsePayload(JSON.parse(base64UrlDecode(payload).toString('utf8')));
  const now = Math.floor(Date.now() / 1000);
  if (parsed.exp <= now) {
    throw new Error('Local auth token is expired.');
  }

  return parsed;
}
