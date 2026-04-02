// On-chain transactions can fail transiently due to:
// - nonce conflicts (two txs sent too close together)
// - gas price spikes (transaction underpriced)
// - RPC node timeouts
// This helper retries the transaction function with exponential backoff.

export interface RetryOptions {
  maxAttempts?:    number;   // default: 3
  initialDelayMs?: number;   // default: 500
  factor?:         number;   // backoff multiplier, default: 2
  onRetry?:        (attempt: number, error: Error) => void;
}

export async function withRetry<T>(
  fn:      () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxAttempts    = 3,
    initialDelayMs = 500,
    factor         = 2,
    onRetry,
  } = options;

  let lastError: Error = new Error('Unknown error');
  let delayMs          = initialDelayMs;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      // Don't retry on hard failures — only on transient ones
      if (isHardFailure(lastError)) throw lastError;

      if (attempt === maxAttempts) break;

      onRetry?.(attempt, lastError);
      await sleep(delayMs);
      delayMs *= factor;
    }
  }

  throw lastError;
}

// Hard failures should not be retried — they indicate a bug or misconfiguration,
// not a transient network issue.
function isHardFailure(error: Error): boolean {
  const msg = error.message.toLowerCase();
  return (
    msg.includes('insufficient funds')  ||  // wallet has no ETH for gas
    msg.includes('execution reverted')  ||  // contract logic rejected the call
    msg.includes('invalid private key') ||  // misconfigured env
    msg.includes('invalid address')
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}