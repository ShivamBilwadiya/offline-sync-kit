import type { ClassifiedError } from '../types/index.js';

export interface HttpResponseLike {
  status: number;
  statusText?: string;
  headers?: {
    get?(name: string): string | null;
    [key: string]: unknown;
  };
}

export interface HttpErrorLike {
  response?: HttpResponseLike;
  status?: number;
  statusCode?: number;
  message?: string;
  code?: string;
}

export function parseRetryAfter(response?: HttpResponseLike): number | undefined {
  if (!response?.headers) return undefined;

  let headerVal: string | null | undefined;
  if (typeof response.headers.get === 'function') {
    headerVal = response.headers.get('retry-after') || response.headers.get('Retry-After');
  } else {
    headerVal = (response.headers['retry-after'] || response.headers['Retry-After']) as string | undefined;
  }

  if (!headerVal) return undefined;

  // Check if integer seconds
  const seconds = parseInt(headerVal, 10);
  if (!isNaN(seconds) && seconds >= 0) {
    return seconds;
  }

  // Check if HTTP date format
  const parsedDate = Date.parse(headerVal);
  if (!isNaN(parsedDate)) {
    const diff = Math.ceil((parsedDate - Date.now()) / 1000);
    return diff > 0 ? diff : 0;
  }

  return undefined;
}

export function classifyHttpError(error: unknown): ClassifiedError {
  const err = error as HttpErrorLike;
  const status = err?.response?.status || err?.status || err?.statusCode;
  const message = (error as Error)?.message || 'Unknown synchronization error';

  // 1. Network Disconnected / Fetch Failures
  if (
    !status &&
    (message.includes('Failed to fetch') ||
      message.includes('NetworkError') ||
      message.includes('ERR_INTERNET_DISCONNECTED') ||
      message.includes('ECONNREFUSED') ||
      message.includes('ENOTFOUND') ||
      (typeof navigator !== 'undefined' && !navigator.onLine))
  ) {
    return {
      category: 'NETWORK_OFFLINE',
      retryable: true,
      message: 'Network offline or unreachable',
      originalError: error,
    };
  }

  // 2. HTTP 401 Unauthorized: whole session expired
  if (status === 401) {
    return {
      category: 'AUTH_EXPIRED',
      retryable: false,
      message: 'Authentication session expired or missing (401)',
      originalError: error,
    };
  }

  // 3. HTTP 403 Forbidden: permission denied for specific resource; do not assume whole session expired
  if (status === 403) {
    return {
      category: 'PERMISSION_DENIED',
      retryable: false,
      message: 'Permission denied for this operation (403)',
      originalError: error,
    };
  }

  // 4. HTTP 408 Request Timeout
  if (status === 408) {
    return {
      category: 'TIMEOUT',
      retryable: true,
      message: 'Request timed out on server (408)',
      originalError: error,
    };
  }

  // 5. HTTP 429 Too Many Requests
  if (status === 429) {
    const retryAfterSeconds = parseRetryAfter(err?.response);
    return {
      category: 'RATE_LIMITED',
      retryable: true,
      retryAfterSeconds,
      message: `Rate limited by server (429)${retryAfterSeconds ? `, retry after ${retryAfterSeconds}s` : ''}`,
      originalError: error,
    };
  }

  // 6. HTTP 409 Conflict
  if (status === 409) {
    return {
      category: 'BUSINESS_CONFLICT',
      retryable: false,
      message: 'Resource conflict detected on server (409)',
      originalError: error,
    };
  }

  // 7. HTTP 400 / 422 Client Validation Errors: permanent
  if (status && status >= 400 && status < 500) {
    return {
      category: 'CLIENT_VALIDATION',
      retryable: false,
      message: `Client validation error (${status}): ${message}`,
      originalError: error,
    };
  }

  // 8. HTTP 5xx Server Errors: transient retryable
  if (status && status >= 500 && status <= 599) {
    return {
      category: 'SERVER_ERROR',
      retryable: true,
      message: `Server returned transient error (${status})`,
      originalError: error,
    };
  }

  // Fallback
  return {
    category: 'UNKNOWN',
    retryable: false,
    message,
    originalError: error,
  };
}
