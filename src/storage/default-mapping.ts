import type { RecordMappingAdapter } from './interface.js';
import type { SyncOperation, StorageKey } from '../types/index.js';

export interface DefaultStorageRecord {
  id: StorageKey;
  idempotencyKey: string;
  type: string;
  createdAt: string;
  status: string;
  retryCount: number;
  maxRetries: number;
  syncStartedAt?: string;
  leaseExpiresAt?: string;
  lastError?: string;
  lastErrorCode?: string;
  conflictData?: unknown;
  payload: unknown;
  unrecognizedFields?: Record<string, unknown>;
}

export const defaultRecordMappingAdapter: RecordMappingAdapter<DefaultStorageRecord> = {
  keyPath: 'id',

  getKey(op: SyncOperation): StorageKey {
    return op.metadata.id;
  },

  toStorage(op: SyncOperation): DefaultStorageRecord {
    return {
      id: op.metadata.id,
      idempotencyKey: op.metadata.idempotencyKey,
      type: op.metadata.type,
      createdAt: op.metadata.createdAt,
      status: op.metadata.status,
      retryCount: op.metadata.retryCount,
      maxRetries: op.metadata.maxRetries,
      syncStartedAt: op.metadata.syncStartedAt,
      leaseExpiresAt: op.metadata.leaseExpiresAt,
      lastError: op.metadata.lastError,
      lastErrorCode: op.metadata.lastErrorCode,
      conflictData: op.metadata.conflictData,
      payload: op.payload,
      unrecognizedFields: op.metadata.unrecognizedFields,
    };
  },

  fromStorage(record: DefaultStorageRecord): SyncOperation {
    return {
      metadata: {
        id: record.id,
        idempotencyKey: record.idempotencyKey,
        type: record.type,
        createdAt: record.createdAt,
        status: record.status as any,
        retryCount: record.retryCount ?? 0,
        maxRetries: record.maxRetries ?? 5,
        syncStartedAt: record.syncStartedAt,
        leaseExpiresAt: record.leaseExpiresAt,
        lastError: record.lastError,
        lastErrorCode: record.lastErrorCode,
        conflictData: record.conflictData,
        unrecognizedFields: record.unrecognizedFields,
      },
      payload: record.payload,
    };
  },
};
