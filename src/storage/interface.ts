import type { StorageKey, SyncOperation } from '../types/index.js';

export interface StorageTransaction {
  get(key: StorageKey): Promise<unknown | null>;
  put(key: StorageKey, value: unknown): Promise<void>;
  delete(key: StorageKey): Promise<void>;
}

export interface StorageAdapter {
  get(key: StorageKey): Promise<unknown | null>;
  getBatch(keys: StorageKey[]): Promise<Array<unknown | null>>;
  getAll(): Promise<unknown[]>;
  put(key: StorageKey, value: unknown): Promise<void>;
  putBatch(entries: Array<{ key: StorageKey; value: unknown }>): Promise<void>;
  delete(key: StorageKey): Promise<void>;
  deleteBatch(keys: StorageKey[]): Promise<void>;
  clear(): Promise<void>;

  /**
   * Atomic record update within an isolated transaction.
   */
  atomicUpdate<TRecord>(
    key: StorageKey,
    updater: (current: TRecord | null) => TRecord
  ): Promise<TRecord>;

  /**
   * Execute multi-operation atomic transaction.
   */
  transaction<R>(
    mode: 'readonly' | 'readwrite',
    operation: (tx: StorageTransaction) => Promise<R>
  ): Promise<R>;

  /** Optional lifecycle close */
  close?(): Promise<void>;
}

export interface RecordMappingAdapter<TStorageRecord = unknown> {
  readonly keyPath: string;
  getKey(op: SyncOperation): StorageKey;
  toStorage(op: SyncOperation): TStorageRecord;
  fromStorage(record: TStorageRecord): SyncOperation;
}
