import { createHmac, timingSafeEqual } from 'crypto';
import { isRecord } from '../utils/object';

export interface JwtClaims extends Record<string, unknown> {
  sub?: string;
  exp?: number;
  iat?: number;
}

const BASE64URL_REGEX = /^[A-Za-z0-9_-]+$/;

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + padding, 'base64').toString('utf8');
}

export function verifyHs256Jwt(token: string, secret: string): JwtClaims {
  const segments = token.split('.');
  if (segments.length !== 3) {
    throw new Error('Invalid JWT format');
  }

  const [encodedHeader, encodedPayload, encodedSignature] = segments;

  if (!BASE64URL_REGEX.test(encodedHeader) || !BASE64URL_REGEX.test(encodedPayload) || !BASE64URL_REGEX.test(encodedSignature)) {
    throw new Error('Invalid JWT characters');
  }

  const header = JSON.parse(decodeBase64Url(encodedHeader)) as Record<string, unknown>;
  if (header['alg'] !== 'HS256') {
    throw new Error('Unsupported JWT algorithm');
  }

  const expectedSignature = createHmac('sha256', secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest('base64url');

  const actualBuffer = Buffer.from(encodedSignature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
    throw new Error('Invalid JWT signature');
  }

  const payload = JSON.parse(decodeBase64Url(encodedPayload));
  if (!isRecord(payload)) {
    throw new Error('Invalid JWT payload');
  }

  const claims = payload as JwtClaims;
  if (typeof claims.exp === 'number') {
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (claims.exp <= nowSeconds) {
      throw new Error('JWT is expired');
    }
  }

  return claims;
}

export function extractBearerToken(value: string | undefined): string | null {
  if (!value) return null;
  const [scheme, token] = value.split(' ');
  if (!scheme || !token) return null;
  if (scheme.toLowerCase() !== 'bearer') return null;
  return token;
}
