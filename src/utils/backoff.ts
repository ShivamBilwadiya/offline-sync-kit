import type { RetryPolicy } from '../types/index.js';

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 5,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  backoffFactor: 2,
  jitter: true,
  retryableHttpStatuses: [408, 429, 500, 502, 503, 504],
};

/**
 * Calculates exponential backoff delay for a given retry count.
 * Formula: min(initialDelay * factor^retryCount, maxDelay) (+/- 20% jitter)
 */
export function calculateBackoffDelay(
  retryCount: number,
  policy: Partial<RetryPolicy> = {}
): number {
  const merged = { ...DEFAULT_RETRY_POLICY, ...policy };
  const baseDelay = Math.min(
    merged.initialDelayMs * Math.pow(merged.backoffFactor, Math.max(0, retryCount)),
    merged.maxDelayMs
  );

  if (!merged.jitter) {
    return Math.round(baseDelay);
  }

  // Apply +/- 20% random jitter to avoid thundering herd
  const jitterFactor = 0.8 + Math.random() * 0.4;
  return Math.round(baseDelay * jitterFactor);
}
