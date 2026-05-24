import { createHash } from "node:crypto";
import type { IncomingMessage } from "http";

import type { RedisClient } from "../redis/client";

type JsonRouteResult = {
  statusCode: number;
  body: unknown;
};

type IdempotencyStoredRecord =
  | {
      state: "processing";
      fingerprint: string;
      startedAt: string;
    }
  | {
      state: "completed";
      fingerprint: string;
      statusCode: number;
      body: unknown;
      completedAt: string;
    };

const IDEMPOTENCY_LOCK_TTL_SECONDS = 10 * 60;
const IDEMPOTENCY_RESPONSE_TTL_SECONDS = 24 * 60 * 60;

function readIdempotencyKey(req: IncomingMessage): string | undefined {
  const rawHeader = req.headers["idempotency-key"];
  const value = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  return trimmed.slice(0, 160);
}

function buildFingerprint(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value ?? null))
    .digest("hex");
}

function buildRedisKey(userId: string, routeKey: string, idempotencyKey: string): string {
  return `idem:${userId}:${routeKey}:${idempotencyKey}`;
}

function parseStoredRecord(raw: string | null): IdempotencyStoredRecord | null {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<IdempotencyStoredRecord>;
    if (parsed.state === "processing" && typeof parsed.fingerprint === "string") {
      return {
        state: "processing",
        fingerprint: parsed.fingerprint,
        startedAt:
          typeof parsed.startedAt === "string"
            ? parsed.startedAt
            : new Date().toISOString(),
      };
    }

    if (
      parsed.state === "completed" &&
      typeof parsed.fingerprint === "string" &&
      typeof parsed.statusCode === "number"
    ) {
      return {
        state: "completed",
        fingerprint: parsed.fingerprint,
        statusCode: parsed.statusCode,
        body: parsed.body ?? {},
        completedAt:
          typeof parsed.completedAt === "string"
            ? parsed.completedAt
            : new Date().toISOString(),
      };
    }

    return null;
  } catch {
    return null;
  }
}

async function tryAcquireRequestLock(
  redisClient: RedisClient,
  redisKey: string,
  fingerprint: string,
): Promise<boolean> {
  const result = await redisClient.send(
    "SET",
    redisKey,
    JSON.stringify({
      state: "processing",
      fingerprint,
      startedAt: new Date().toISOString(),
    } satisfies IdempotencyStoredRecord),
    "NX",
    "EX",
    String(IDEMPOTENCY_LOCK_TTL_SECONDS),
  );

  return result === "OK";
}

export async function runIdempotentJsonRequest(params: {
  req: IncomingMessage;
  redisClient: RedisClient;
  userId: string;
  routeKey: string;
  requestBody: unknown;
  execute: () => Promise<JsonRouteResult>;
}): Promise<JsonRouteResult> {
  const idempotencyKey = readIdempotencyKey(params.req);
  if (!idempotencyKey) {
    return params.execute();
  }

  const fingerprint = buildFingerprint(params.requestBody);
  const redisKey = buildRedisKey(params.userId, params.routeKey, idempotencyKey);

  const acquire = async (): Promise<boolean> =>
    tryAcquireRequestLock(params.redisClient, redisKey, fingerprint);

  if (await acquire()) {
    try {
      const result = await params.execute();
      await params.redisClient.set(
        redisKey,
        JSON.stringify({
          state: "completed",
          fingerprint,
          statusCode: result.statusCode,
          body: result.body,
          completedAt: new Date().toISOString(),
        } satisfies IdempotencyStoredRecord),
        IDEMPOTENCY_RESPONSE_TTL_SECONDS,
      );
      return result;
    } catch (error) {
      await params.redisClient.del(redisKey).catch(() => undefined);
      throw error;
    }
  }

  let storedRecord = parseStoredRecord(await params.redisClient.get(redisKey));

  if (!storedRecord && (await acquire())) {
    try {
      const result = await params.execute();
      await params.redisClient.set(
        redisKey,
        JSON.stringify({
          state: "completed",
          fingerprint,
          statusCode: result.statusCode,
          body: result.body,
          completedAt: new Date().toISOString(),
        } satisfies IdempotencyStoredRecord),
        IDEMPOTENCY_RESPONSE_TTL_SECONDS,
      );
      return result;
    } catch (error) {
      await params.redisClient.del(redisKey).catch(() => undefined);
      throw error;
    }
  }

  if (!storedRecord) {
    return {
      statusCode: 409,
      body: {
        error: "This request is already being processed. Try again in a moment.",
      },
    };
  }

  if (storedRecord.fingerprint !== fingerprint) {
    return {
      statusCode: 409,
      body: {
        error: "This idempotency key is already in use for a different request.",
      },
    };
  }

  if (storedRecord.state === "completed") {
    return {
      statusCode: storedRecord.statusCode,
      body: storedRecord.body,
    };
  }

  return {
    statusCode: 409,
    body: {
      error: "This request is already being processed. Try again in a moment.",
    },
  };
}
