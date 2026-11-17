import type { LockManager, LockSession } from './interface.js';
import { generateUUID } from '../utils/uuid.js';

export class WebLocksManager implements LockManager {
  private readonly ownerId: string;

  constructor(ownerId?: string) {
    this.ownerId = ownerId || `tab-${generateUUID().substring(0, 8)}`;
  }

  async withLock<T>(
    name: string,
    callback: (session: LockSession) => Promise<T>,
    timeoutMs?: number
  ): Promise<T> {
    if (typeof navigator === 'undefined' || !navigator.locks) {
      throw new Error('Web Locks API is not available in this environment');
    }

    const abortController = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    if (timeoutMs !== undefined && timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        abortController.abort(new Error(`Timed out waiting for lock '${name}' after ${timeoutMs}ms`));
      }, timeoutMs);
    }

    try {
      return await navigator.locks.request(
        name,
        { signal: abortController.signal },
        async (lock) => {
          if (timeoutId) clearTimeout(timeoutId);
          if (!lock) {
            throw new Error(`Failed to acquire Web Lock '${name}'`);
          }

          const session: LockSession = {
            lockName: name,
            ownerId: this.ownerId,
            abortSignal: abortController.signal,
          };

          return await callback(session);
        }
      );
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  async destroy(): Promise<void> {
    // No explicit teardown required for Web Locks
  }
}
