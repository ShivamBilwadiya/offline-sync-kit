import type { StorageAdapter, StorageTransaction } from './interface.js';
import type { StorageKey } from '../types/index.js';

export class MemoryStorageAdapter implements StorageAdapter {
  private data = new Map<StorageKey, unknown>();

  async get(key: StorageKey): Promise<unknown | null> {
    const val = this.data.get(key);
    return val !== undefined ? structuredClone(val) : null;
  }

  async getBatch(keys: StorageKey[]): Promise<Array<unknown | null>> {
    return Promise.all(keys.map((k) => this.get(k)));
  }

  async getAll(): Promise<unknown[]> {
    return Array.from(this.data.values()).map((v) => structuredClone(v));
  }

  async put(key: StorageKey, value: unknown): Promise<void> {
    this.data.set(key, structuredClone(value));
  }

  async putBatch(entries: Array<{ key: StorageKey; value: unknown }>): Promise<void> {
    for (const entry of entries) {
      this.data.set(entry.key, structuredClone(entry.value));
    }
  }

  async delete(key: StorageKey): Promise<void> {
    this.data.delete(key);
  }

  async deleteBatch(keys: StorageKey[]): Promise<void> {
    for (const key of keys) {
      this.data.delete(key);
    }
  }

  async clear(): Promise<void> {
    this.data.clear();
  }

  async atomicUpdate<TRecord>(
    key: StorageKey,
    updater: (current: TRecord | null) => TRecord
  ): Promise<TRecord> {
    const current = this.data.get(key);
    const clonedCurrent = current !== undefined ? (structuredClone(current) as TRecord) : null;
    const next = updater(clonedCurrent);
    this.data.set(key, structuredClone(next));
    return structuredClone(next);
  }

  async transaction<R>(
    mode: 'readonly' | 'readwrite',
    operation: (tx: StorageTransaction) => Promise<R>
  ): Promise<R> {
    if (mode === 'readonly') {
      const tx: StorageTransaction = {
        get: async (k) => this.get(k),
        put: async () => {
          throw new Error('Cannot write in a readonly transaction');
        },
        delete: async () => {
          throw new Error('Cannot delete in a readonly transaction');
        },
      };
      return await operation(tx);
    }

    // Readwrite transaction with rollback
    const backup = new Map(this.data);
    const stagedChanges = new Map<StorageKey, unknown | undefined>();

    const tx: StorageTransaction = {
      get: async (k) => {
        if (stagedChanges.has(k)) {
          const staged = stagedChanges.get(k);
          return staged !== undefined ? structuredClone(staged) : null;
        }
        return this.get(k);
      },
      put: async (k, v) => {
        stagedChanges.set(k, structuredClone(v));
      },
      delete: async (k) => {
        stagedChanges.set(k, undefined);
      },
    };

    try {
      const result = await operation(tx);
      // Commit
      for (const [k, v] of stagedChanges.entries()) {
        if (v === undefined) {
          this.data.delete(k);
        } else {
          this.data.set(k, v);
        }
      }
      return result;
    } catch (err) {
      // Rollback
      this.data = backup;
      throw err;
    }
  }

  async close(): Promise<void> {
    // No-op for memory
  }
}
