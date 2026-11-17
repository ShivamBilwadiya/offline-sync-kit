import type { LockManager, LockSession } from './interface.js';
import { generateUUID } from '../utils/uuid.js';
import { LockLostError } from '../errors.js';

interface LockRecord {
  name: string;
  ownerId: string;
  acquiredAt: number;
  leaseExpiresAt: number;
}

export interface FallbackLockOptions {
  lockDbName?: string;
  leaseDurationMs?: number;
  renewalIntervalMs?: number;
  retryIntervalMs?: number;
  ownerId?: string;
}

export class FallbackIndexedDBLockManager implements LockManager {
  private readonly dbName: string;
  private readonly storeName = 'locks';
  private readonly leaseDurationMs: number;
  private readonly renewalIntervalMs: number;
  private readonly retryIntervalMs: number;
  private readonly ownerId: string;
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(options: FallbackLockOptions = {}) {
    this.dbName = options.lockDbName || 'offline_sync_kit_locks';
    this.leaseDurationMs = options.leaseDurationMs || 15000;
    this.renewalIntervalMs = options.renewalIntervalMs || 5000;
    this.retryIntervalMs = options.retryIntervalMs || 250;
    this.ownerId = options.ownerId || `fallback-${generateUUID().substring(0, 8)}`;
  }

  private getDB(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;

    this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB is not available for lock fallback'));
        return;
      }

      const request = indexedDB.open(this.dbName, 1);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName, { keyPath: 'name' });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        this.dbPromise = null;
        reject(request.error);
      };
    });

    return this.dbPromise;
  }

  private async tryAcquire(name: string): Promise<boolean> {
    const db = await this.getDB();
    const now = Date.now();
    const expiresAt = now + this.leaseDurationMs;

    return new Promise<boolean>((resolve, reject) => {
      try {
        const tx = db.transaction(this.storeName, 'readwrite');
        const store = tx.objectStore(this.storeName);
        const req = store.get(name);
        let acquired = false;

        req.onsuccess = () => {
          const existing = req.result as LockRecord | undefined;

          // Check if lock is free or expired (stale recovery)
          if (!existing || existing.leaseExpiresAt < now || existing.ownerId === this.ownerId) {
            const newRecord: LockRecord = {
              name,
              ownerId: this.ownerId,
              acquiredAt: now,
              leaseExpiresAt: expiresAt,
            };
            store.put(newRecord);
            acquired = true;
          } else {
            acquired = false;
          }
        };

        tx.oncomplete = () => resolve(acquired);
        req.onerror = () => reject(req.error);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => resolve(false);
      } catch (err) {
        reject(err);
      }
    });
  }

  private async renewLease(name: string): Promise<boolean> {
    const db = await this.getDB();
    const now = Date.now();
    const expiresAt = now + this.leaseDurationMs;

    return new Promise<boolean>((resolve) => {
      try {
        const tx = db.transaction(this.storeName, 'readwrite');
        const store = tx.objectStore(this.storeName);
        const req = store.get(name);
        let renewed = false;

        req.onsuccess = () => {
          const existing = req.result as LockRecord | undefined;
          if (existing && existing.ownerId === this.ownerId) {
            store.put({
              ...existing,
              leaseExpiresAt: expiresAt,
            });
            renewed = true;
          } else {
            // Lock was stolen or expired
            renewed = false;
          }
        };

        tx.oncomplete = () => resolve(renewed);
        req.onerror = () => resolve(false);
        tx.onerror = () => resolve(false);
        tx.onabort = () => resolve(false);
      } catch {
        resolve(false);
      }
    });
  }

  private async releaseLock(name: string): Promise<void> {
    try {
      const db = await this.getDB();
      await new Promise<void>((resolve) => {
        const tx = db.transaction(this.storeName, 'readwrite');
        const store = tx.objectStore(this.storeName);
        const req = store.get(name);

        req.onsuccess = () => {
          const existing = req.result as LockRecord | undefined;
          if (existing && existing.ownerId === this.ownerId) {
            store.delete(name);
          }
        };

        tx.oncomplete = () => resolve();
        req.onerror = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      });
    } catch {
      // Ignore release errors on teardown
    }
  }

  async withLock<T>(
    name: string,
    callback: (session: LockSession) => Promise<T>,
    timeoutMs: number = 30000
  ): Promise<T> {
    const startTime = Date.now();
    let acquired = false;

    // Poll until acquired or timed out
    while (!acquired) {
      acquired = await this.tryAcquire(name);
      if (acquired) break;

      if (Date.now() - startTime >= timeoutMs) {
        throw new Error(`Timed out waiting to acquire fallback lock '${name}' after ${timeoutMs}ms`);
      }

      await new Promise((r) => setTimeout(r, this.retryIntervalMs));
    }

    const abortController = new AbortController();

    // Lease renewal heartbeat
    const renewalTimer = setInterval(async () => {
      const renewed = await this.renewLease(name);
      if (!renewed) {
        clearInterval(renewalTimer);
        abortController.abort(new LockLostError(name, 'Lease renewal failed or lock was preempted.'));
      }
    }, this.renewalIntervalMs);

    const session: LockSession = {
      lockName: name,
      ownerId: this.ownerId,
      abortSignal: abortController.signal,
    };

    try {
      return await callback(session);
    } finally {
      clearInterval(renewalTimer);
      await this.releaseLock(name);
    }
  }

  async destroy(): Promise<void> {
    if (this.dbPromise) {
      const db = await this.dbPromise;
      db.close();
      this.dbPromise = null;
    }
  }
}
