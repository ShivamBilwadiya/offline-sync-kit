import type { StorageAdapter, StorageTransaction } from './interface.js';
import type { StorageKey } from '../types/index.js';
import { StorageError } from '../errors.js';

export interface IndexedDBAdapterOptions {
  dbName: string;
  storeName: string;
  version?: number;
  keyPath?: string;
}

export class IndexedDBStorageAdapter implements StorageAdapter {
  private dbPromise: Promise<IDBDatabase> | null = null;
  private readonly dbName: string;
  private readonly storeName: string;
  private readonly version?: number;
  private readonly keyPath: string;

  constructor(options: IndexedDBAdapterOptions) {
    this.dbName = options.dbName;
    this.storeName = options.storeName;
    this.version = options.version;
    this.keyPath = options.keyPath || 'id';
  }

  private getDB(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;

    this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new StorageError('IndexedDB is not supported in this runtime environment.'));
        return;
      }

      const request = this.version !== undefined
        ? indexedDB.open(this.dbName, this.version)
        : indexedDB.open(this.dbName);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName, { keyPath: this.keyPath });
        }
      };

      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          this.dbPromise = null;
        };
        resolve(db);
      };

      request.onerror = () => {
        this.dbPromise = null;
        reject(new StorageError(`Failed to open IndexedDB '${this.dbName}'`, request.error));
      };
    });

    return this.dbPromise;
  }

  async get(key: StorageKey): Promise<unknown | null> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(this.storeName, 'readonly');
        const store = tx.objectStore(this.storeName);
        const req = store.get(key as IDBValidKey);

        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = () => reject(new StorageError(`Failed to get key '${key}'`, req.error));
      } catch (err) {
        reject(new StorageError(`Transaction error on get '${key}'`, err));
      }
    });
  }

  async getBatch(keys: StorageKey[]): Promise<Array<unknown | null>> {
    if (keys.length === 0) return [];
    const db = await this.getDB();

    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(this.storeName, 'readonly');
        const store = tx.objectStore(this.storeName);
        const results: Array<unknown | null> = new Array(keys.length);
        let completed = 0;

        for (let i = 0; i < keys.length; i++) {
          const req = store.get(keys[i] as IDBValidKey);
          req.onsuccess = () => {
            results[i] = req.result ?? null;
            completed++;
            if (completed === keys.length) {
              resolve(results);
            }
          };
          req.onerror = () => reject(new StorageError('Failed batch get', req.error));
        }

        tx.onerror = () => reject(new StorageError('Transaction error in getBatch', tx.error));
      } catch (err) {
        reject(new StorageError('Transaction error in getBatch', err));
      }
    });
  }

  async getAll(): Promise<unknown[]> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(this.storeName, 'readonly');
        const store = tx.objectStore(this.storeName);
        const req = store.getAll();

        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(new StorageError('Failed to get all records', req.error));
      } catch (err) {
        reject(new StorageError('Transaction error in getAll', err));
      }
    });
  }

  async put(key: StorageKey, value: unknown): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(this.storeName, 'readwrite');
        const store = tx.objectStore(this.storeName);
        
        // If store has keyPath and value is an object, store.put(value) is used
        if (store.keyPath) {
          store.put(value);
        } else {
          store.put(value, key as IDBValidKey);
        }

        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(new StorageError(`Failed to put key '${key}'`, tx.error));
        tx.onabort = () => reject(new StorageError(`Transaction aborted on put '${key}'`, tx.error));
      } catch (err) {
        reject(new StorageError(`Transaction error in put '${key}'`, err));
      }
    });
  }

  async putBatch(entries: Array<{ key: StorageKey; value: unknown }>): Promise<void> {
    if (entries.length === 0) return;
    const db = await this.getDB();

    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(this.storeName, 'readwrite');
        const store = tx.objectStore(this.storeName);

        for (const entry of entries) {
          if (store.keyPath) {
            store.put(entry.value);
          } else {
            store.put(entry.value, entry.key as IDBValidKey);
          }
        }

        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(new StorageError('Failed to execute putBatch', tx.error));
        tx.onabort = () => reject(new StorageError('Transaction aborted on putBatch', tx.error));
      } catch (err) {
        reject(new StorageError('Transaction error in putBatch', err));
      }
    });
  }

  async delete(key: StorageKey): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(this.storeName, 'readwrite');
        const store = tx.objectStore(this.storeName);
        store.delete(key as IDBValidKey);

        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(new StorageError(`Failed to delete key '${key}'`, tx.error));
        tx.onabort = () => reject(new StorageError(`Transaction aborted on delete '${key}'`, tx.error));
      } catch (err) {
        reject(new StorageError(`Transaction error in delete '${key}'`, err));
      }
    });
  }

  async deleteBatch(keys: StorageKey[]): Promise<void> {
    if (keys.length === 0) return;
    const db = await this.getDB();

    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(this.storeName, 'readwrite');
        const store = tx.objectStore(this.storeName);

        for (const key of keys) {
          store.delete(key as IDBValidKey);
        }

        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(new StorageError('Failed to execute deleteBatch', tx.error));
        tx.onabort = () => reject(new StorageError('Transaction aborted on deleteBatch', tx.error));
      } catch (err) {
        reject(new StorageError('Transaction error in deleteBatch', err));
      }
    });
  }

  async clear(): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(this.storeName, 'readwrite');
        const store = tx.objectStore(this.storeName);
        store.clear();

        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(new StorageError('Failed to clear store', tx.error));
        tx.onabort = () => reject(new StorageError('Transaction aborted on clear', tx.error));
      } catch (err) {
        reject(new StorageError('Transaction error in clear', err));
      }
    });
  }

  /**
   * Atomic record update.
   * Crucial: get and put execute synchronously inside the IDB request callback,
   * guaranteeing no microtask delay so the transaction remains active until completion.
   */
  async atomicUpdate<TRecord>(
    key: StorageKey,
    updater: (current: TRecord | null) => TRecord
  ): Promise<TRecord> {
    const db = await this.getDB();

    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(this.storeName, 'readwrite');
        const store = tx.objectStore(this.storeName);
        const req = store.get(key as IDBValidKey);

        let updatedRecord: TRecord;

        req.onsuccess = () => {
          try {
            const current = (req.result ?? null) as TRecord | null;
            updatedRecord = updater(current);

            if (store.keyPath) {
              store.put(updatedRecord);
            } else {
              store.put(updatedRecord, key as IDBValidKey);
            }
          } catch (updateErr) {
            tx.abort();
            reject(updateErr);
          }
        };

        req.onerror = () => {
          reject(new StorageError(`Failed to fetch key '${key}' during atomicUpdate`, req.error));
        };

        tx.oncomplete = () => {
          resolve(updatedRecord);
        };

        tx.onerror = () => {
          reject(new StorageError(`Atomic update transaction failed for key '${key}'`, tx.error));
        };

        tx.onabort = () => {
          reject(new StorageError(`Atomic update transaction aborted for key '${key}'`, tx.error));
        };
      } catch (err) {
        reject(new StorageError(`Failed to start atomicUpdate transaction for key '${key}'`, err));
      }
    });
  }

  async transaction<R>(
    mode: 'readonly' | 'readwrite',
    operation: (tx: StorageTransaction) => Promise<R>
  ): Promise<R> {
    const db = await this.getDB();

    return new Promise<R>((resolve, reject) => {
      try {
        const idbTx = db.transaction(this.storeName, mode);
        const store = idbTx.objectStore(this.storeName);

        const storageTx: StorageTransaction = {
          get: (k) => new Promise((res, rej) => {
            const req = store.get(k as IDBValidKey);
            req.onsuccess = () => res(req.result ?? null);
            req.onerror = () => rej(req.error);
          }),
          put: (k, v) => new Promise((res, rej) => {
            const req = store.keyPath ? store.put(v) : store.put(v, k as IDBValidKey);
            req.onsuccess = () => res();
            req.onerror = () => rej(req.error);
          }),
          delete: (k) => new Promise((res, rej) => {
            const req = store.delete(k as IDBValidKey);
            req.onsuccess = () => res();
            req.onerror = () => rej(req.error);
          }),
        };

        let opResult: R;
        let opDone = false;
        let txCompleted = false;

        idbTx.oncomplete = () => {
          txCompleted = true;
          if (opDone) resolve(opResult);
        };
        idbTx.onerror = () => reject(idbTx.error);
        idbTx.onabort = () => reject(new StorageError('Transaction aborted', idbTx.error));

        let resultPromise: Promise<R>;
        try {
          resultPromise = operation(storageTx);
        } catch (opErr) {
          try { idbTx.abort(); } catch {}
          reject(opErr);
          return;
        }

        resultPromise
          .then((res) => {
            opResult = res;
            opDone = true;
            if (txCompleted) resolve(opResult);
          })
          .catch((err) => {
            try { idbTx.abort(); } catch {}
            reject(err);
          });
      } catch (err) {
        reject(new StorageError('Failed to initialize transaction', err));
      }
    });
  }

  async close(): Promise<void> {
    if (this.dbPromise) {
      const db = await this.dbPromise;
      db.close();
      this.dbPromise = null;
    }
  }
}
