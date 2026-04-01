import { ZodError } from 'zod';
import { sendToDlq } from './dlq';

// Errors that are worth retrying — transient infra problems.
// Zod errors, business logic errors, and type errors are NOT retried
// because they will fail identically every time.
const RETRYABLE_ERROR_NAMES = new Set([
  'KafkaJSError',
  'KafkaJSConnectionError',
  'KafkaJSRequestTimeoutError',
  'KafkaJSNonRetriableError',
  'TimeoutError',
  'FetchError',
]);

function isRetryable(error: unknown): boolean {
  if (error instanceof ZodError) return false;
  if (error instanceof TypeError) return false;
  if (error instanceof SyntaxError) return false; // JSON.parse failures
  if (error instanceof Error) {
    return RETRYABLE_ERROR_NAMES.has(error.name) ||
      error.message.includes('ECONNREFUSED') ||
      error.message.includes('ETIMEDOUT') ||
      error.message.includes('socket hang up');
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Retries handler up to maxAttempts times with exponential backoff.
// Skips retries entirely for non-retryable errors (Zod, syntax, type).
// Returns the number of attempts made — used by withErrorBoundary for DLQ metadata.
export async function withRetry<T>(
  handler: () => Promise<T>,
  maxAttempts = 3,
): Promise<{ result: T; attempts: number }> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await handler();
      return { result, attempts: attempt };
    } catch (error) {
      lastError = error;

      // Non-retryable — bail immediately, don't waste attempts
      if (!isRetryable(error)) {
        throw error;
      }

      // Don't sleep after the last attempt
      if (attempt < maxAttempts) {
        const backoffMs = 500 * Math.pow(2, attempt - 1); // 500ms, 1s, 2s
        await sleep(Math.min(backoffMs, 10_000));          // cap at 10s
      }
    }
  }

  throw lastError;
}

// Outer wrapper that catches anything withRetry doesn't recover from
// and sends the raw message to the DLQ.
// This is the last line of defence before a message is lost.
// NEVER throws — consumer loop must keep running even after failures.
export async function withErrorBoundary(
  handler: () => Promise<void>,
  context: {
    topic:      string;
    rawMessage: string | Buffer | null;
    maxRetries?: number;
  },
): Promise<void> {
  const { topic, rawMessage, maxRetries = 3 } = context;

  try {
    await withRetry(handler, maxRetries);
  } catch (error) {
    const attempts = maxRetries; // exhausted

    process.stderr.write(
      JSON.stringify({
        level:   'error',
        msg:     'Message handler failed after all retries — sending to DLQ',
        topic,
        error:   error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      }) + '\n',
    );

    await sendToDLQ(topic, rawMessage, error, { attemptCount: attempts });
  }
}