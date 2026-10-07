export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  // If provided, only errors passing this check are retried; anything else
  // is thrown immediately on the first failure.
  isRetryable?: (error: unknown) => boolean;
}

// Shared retry-with-backoff helper. Transient failures (throttling, timeouts,
// connection resets) are common when talking to any external API and
// shouldn't be reimplemented per-module with a different policy each time.
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { attempts = 3, baseDelayMs = 300, isRetryable } = options;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const retryable = isRetryable ? isRetryable(error) : true;
      if (!retryable || attempt === attempts) break;
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** (attempt - 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
