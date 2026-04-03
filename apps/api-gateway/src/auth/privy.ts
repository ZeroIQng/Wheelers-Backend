import { createPublicKey, verify } from 'crypto';
import { isRecord } from '../utils/object';

export interface PrivyVerificationInput {
  accessToken: string;
  appId: string;
  verificationKey: string;
}

export interface VerifiedPrivyToken {
  privyDid: string;
  issuer: string;
  appId: string;
  sessionId?: string;
  claims: Record<string, unknown>;
}

interface JwtHeader {
  alg?: string;
  kid?: string;
  typ?: string;
}

function base64UrlDecode(value: string): Buffer {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + padding, 'base64');
}

function decodeJwtSegment<T>(segment: string): T {
  const decoded = base64UrlDecode(segment).toString('utf8');
  return JSON.parse(decoded) as T;
}

function normalizePemPublicKey(value: string): string {
  const trimmed = value.trim().replace(/\\n/g, '\n');

  if (trimmed.includes('BEGIN PUBLIC KEY')) {
    return trimmed;
  }

  const compact = trimmed.replace(/\s+/g, '');
  const lines = compact.match(/.{1,64}/g)?.join('\n') ?? compact;
  return `-----BEGIN PUBLIC KEY-----\n${lines}\n-----END PUBLIC KEY-----`;
}

function joseEs256SignatureToDer(rawSignature: Buffer): Buffer {
  if (rawSignature.length !== 64) {
    throw new Error('Invalid ES256 signature length');
  }

  const r = rawSignature.subarray(0, 32);
  const s = rawSignature.subarray(32, 64);

  const encodeInteger = (value: Buffer): Buffer => {
    let i = 0;
    while (i < value.length - 1 && value[i] === 0) i += 1;
    let output = value.subarray(i);

    if (output[0] && (output[0] & 0x80) !== 0) {
      output = Buffer.concat([Buffer.from([0x00]), output]);
    }

    return Buffer.concat([Buffer.from([0x02, output.length]), output]);
  };

  const derR = encodeInteger(r);
  const derS = encodeInteger(s);
  const sequenceBody = Buffer.concat([derR, derS]);

  return Buffer.concat([Buffer.from([0x30, sequenceBody.length]), sequenceBody]);
}

function readAudience(claims: Record<string, unknown>): string[] {
  const aud = claims['aud'];

  if (typeof aud === 'string') {
    return [aud];
  }

  if (Array.isArray(aud)) {
    return aud.filter((value): value is string => typeof value === 'string');
  }

  return [];
}

export function verifyPrivyAccessToken(input: PrivyVerificationInput): VerifiedPrivyToken {
  const segments = input.accessToken.split('.');
  if (segments.length !== 3) {
    throw new Error('Invalid Privy access token format');
  }

  const [encodedHeader, encodedPayload, encodedSignature] = segments;
  const header = decodeJwtSegment<JwtHeader>(encodedHeader);

  if (header.alg !== 'ES256') {
    throw new Error(`Unsupported Privy token algorithm: ${header.alg ?? 'unknown'}`);
  }

  const payload = decodeJwtSegment<unknown>(encodedPayload);
  if (!isRecord(payload)) {
    throw new Error('Invalid Privy token payload');
  }

  const claims = payload as Record<string, unknown>;

  const issuer = claims['iss'];
  if (typeof issuer !== 'string' || !issuer.includes('privy')) {
    throw new Error('Invalid Privy token issuer');
  }

  const audience = readAudience(claims);
  if (!audience.includes(input.appId)) {
    throw new Error('Privy token audience does not match PRIVY_APP_ID');
  }

  const exp = claims['exp'];
  if (typeof exp !== 'number') {
    throw new Error('Privy token missing exp claim');
  }

  const now = Math.floor(Date.now() / 1000);
  if (exp <= now) {
    throw new Error('Privy access token is expired');
  }

  const privyDid = claims['sub'];
  if (typeof privyDid !== 'string' || privyDid.length === 0) {
    throw new Error('Privy token missing subject claim');
  }

  const publicKey = createPublicKey(normalizePemPublicKey(input.verificationKey));
  const rawSignature = base64UrlDecode(encodedSignature);
  const derSignature = joseEs256SignatureToDer(rawSignature);

  const verified = verify(
    'sha256',
    Buffer.from(`${encodedHeader}.${encodedPayload}`, 'utf8'),
    publicKey,
    derSignature,
  );

  if (!verified) {
    throw new Error('Privy access token signature verification failed');
  }

  return {
    privyDid,
    issuer,
    appId: input.appId,
    sessionId: typeof claims['sid'] === 'string' ? claims['sid'] : undefined,
    claims,
  };
}
