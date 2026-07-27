import { createHash, randomInt, timingSafeEqual } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import { userClient } from '@wheleers/db';
import type { RedisClient } from '../redis/client';
import { hashPassword } from '../auth/local';
import { getString, isRecord } from '../utils/object';
import { readJsonBody, sendJson } from './utils';
import { sendEmail } from '../email/resend';
import { buildPasswordResetEmail } from '../email/templates';

const RESET_CODE_KEY_PREFIX = 'auth:pw-reset:';
const RESET_CODE_LENGTH = 6;
const RESET_CODE_TTL_SECONDS = 600; // 10 minutes

interface PasswordResetDeps {
  redisClient: RedisClient;
  resendApiKey?: string;
}

function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

function buildResetCode(): string {
  const max = 10 ** RESET_CODE_LENGTH;
  return String(randomInt(0, max)).padStart(RESET_CODE_LENGTH, '0');
}

function buildResetRedisKey(email: string): string {
  return `${RESET_CODE_KEY_PREFIX}${email.toLowerCase()}`;
}

function timingSafeStringEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

function normalizeEmail(value: string | undefined): string | undefined {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed) return undefined;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return undefined;
  return trimmed;
}

// ── POST /auth/forgot-password ──────────────────────────────────────

export async function handleForgotPasswordRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: PasswordResetDeps,
): Promise<void> {
  try {
    const rawBody = await readJsonBody(req);
    if (!isRecord(rawBody)) {
      sendJson(res, 400, { error: 'Body must be a JSON object' });
      return;
    }

    const email = normalizeEmail(getString(rawBody, 'email'));
    if (!email) {
      sendJson(res, 400, { error: 'A valid email address is required.' });
      return;
    }

    if (!deps.resendApiKey) {
      sendJson(res, 503, { error: 'Email service not configured.' });
      return;
    }

    // Always return 200 to prevent email enumeration
    const user = await userClient.findByEmail(email);

    if (user && user.passwordHash) {
      const code = buildResetCode();
      const codeHash = hashCode(code);

      await deps.redisClient.set(
        buildResetRedisKey(email),
        JSON.stringify({ codeHash, email }),
        RESET_CODE_TTL_SECONDS,
      );

      const template = buildPasswordResetEmail(code);
      await sendEmail({ to: email, ...template }, deps.resendApiKey);
    }

    sendJson(res, 200, { sent: true });
  } catch (error) {
    console.warn('[auth/forgot-password] error', {
      error: error instanceof Error ? error.message : String(error),
    });
    sendJson(res, 200, { sent: true });
  }
}

// ── POST /auth/verify-reset-code ────────────────────────────────────

export async function handleVerifyResetCodeRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: PasswordResetDeps,
): Promise<void> {
  try {
    const rawBody = await readJsonBody(req);
    if (!isRecord(rawBody)) {
      sendJson(res, 400, { error: 'Body must be a JSON object' });
      return;
    }

    const email = normalizeEmail(getString(rawBody, 'email'));
    const code = getString(rawBody, 'code')?.trim();

    if (!email || !code) {
      sendJson(res, 400, { error: 'email and code are required.' });
      return;
    }

    const stored = await deps.redisClient.get(buildResetRedisKey(email));
    if (!stored) {
      sendJson(res, 400, { error: 'Code expired or not found. Request a new one.' });
      return;
    }

    const parsed = JSON.parse(stored as string) as { codeHash: string; email: string };
    if (!timingSafeStringEquals(hashCode(code), parsed.codeHash)) {
      sendJson(res, 400, { error: 'Invalid code.' });
      return;
    }

    sendJson(res, 200, { valid: true });
  } catch (error) {
    sendJson(res, 400, {
      error: error instanceof Error ? error.message : 'Verification failed.',
    });
  }
}

// ── POST /auth/reset-password ───────────────────────────────────────

export async function handleResetPasswordRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: PasswordResetDeps,
): Promise<void> {
  try {
    const rawBody = await readJsonBody(req);
    if (!isRecord(rawBody)) {
      sendJson(res, 400, { error: 'Body must be a JSON object' });
      return;
    }

    const email = normalizeEmail(getString(rawBody, 'email'));
    const code = getString(rawBody, 'code')?.trim();
    const newPassword = getString(rawBody, 'newPassword');

    if (!email || !code || !newPassword) {
      sendJson(res, 400, { error: 'email, code, and newPassword are required.' });
      return;
    }

    if (newPassword.length < 8 || newPassword.length > 128) {
      sendJson(res, 400, { error: 'Password must be between 8 and 128 characters.' });
      return;
    }

    const redisKey = buildResetRedisKey(email);
    const stored = await deps.redisClient.get(redisKey);
    if (!stored) {
      sendJson(res, 400, { error: 'Code expired or not found. Request a new one.' });
      return;
    }

    const parsed = JSON.parse(stored as string) as { codeHash: string; email: string };
    if (!timingSafeStringEquals(hashCode(code), parsed.codeHash)) {
      sendJson(res, 400, { error: 'Invalid code.' });
      return;
    }

    // Find the user and update their password
    const user = await userClient.findByEmail(email);
    if (!user) {
      sendJson(res, 400, { error: 'Account not found.' });
      return;
    }

    const passwordHash = await hashPassword(newPassword);
    await userClient.updateAuthIdentity(user.id, { passwordHash });

    // Delete the reset code so it can't be reused
    await deps.redisClient.del(redisKey);

    sendJson(res, 200, { reset: true });
  } catch (error) {
    sendJson(res, 400, {
      error: error instanceof Error ? error.message : 'Password reset failed.',
    });
  }
}
