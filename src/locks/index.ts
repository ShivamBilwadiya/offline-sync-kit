import type { LockManager, LockSession } from './interface.js';
import { WebLocksManager } from './web-locks.js';
import { FallbackIndexedDBLockManager, FallbackLockOptions } from './fallback-indexeddb.js';

export * from './interface.js';
export * from './web-locks.js';
export * from './fallback-indexeddb.js';

export class InMemoryLockManager implements LockManager {
  private static sharedActiveLocks = new Set<string>();

  async withLock<T>(
    name: string,
    callback: (session: LockSession) => Promise<T>,
    timeoutMs: number = 30000
  ): Promise<T> {
    const start = Date.now();
    while (InMemoryLockManager.sharedActiveLocks.has(name)) {
      if (Date.now() - start >= timeoutMs) {
        throw new Error(`Timed out waiting for in-memory lock '${name}'`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    InMemoryLockManager.sharedActiveLocks.add(name);
    const abortController = new AbortController();

    const session: LockSession = {
      lockName: name,
      ownerId: 'in-memory',
      abortSignal: abortController.signal,
    };

    try {
      return await callback(session);
    } finally {
      InMemoryLockManager.sharedActiveLocks.delete(name);
    }
  }

  async destroy(): Promise<void> {
    InMemoryLockManager.sharedActiveLocks.clear();
  }
}

export function createLockManager(options: {
  preferWebLocks?: boolean;
  fallbackOptions?: FallbackLockOptions;
} = {}): LockManager {
  const preferWebLocks = options.preferWebLocks !== false;

  if (preferWebLocks && typeof navigator !== 'undefined' && 'locks' in navigator && navigator.locks) {
    return new WebLocksManager();
  }

  if (typeof indexedDB !== 'undefined') {
    return new FallbackIndexedDBLockManager(options.fallbackOptions);
  }

  return new InMemoryLockManager();
}
