import type {
  SyncOperation,
  SyncOperationStatus,
  StorageKey,
  EnqueueOptions,
  LeaseConfig,
} from './types/index.js';
import type { StorageAdapter, RecordMappingAdapter } from './storage/interface.js';
import { defaultRecordMappingAdapter } from './storage/default-mapping.js';
import { assertValidTransition } from './state-machine.js';
import { generateUUID } from './utils/uuid.js';
import type { TypedEventEmitter } from './utils/events.js';

export interface SyncQueueOptions<TRecord = unknown> {
  storage: StorageAdapter;
  mapping?: RecordMappingAdapter<TRecord>;
  events?: TypedEventEmitter;
  defaultMaxRetries?: number;
}

export class SyncQueue<TPayload = unknown, TRecord = unknown> {
  private readonly storage: StorageAdapter;
  private readonly mapping: RecordMappingAdapter<TRecord>;
  private readonly events?: TypedEventEmitter;
  private readonly defaultMaxRetries: number;

  constructor(options: SyncQueueOptions<TRecord>) {
    this.storage = options.storage;
    this.mapping = options.mapping || (defaultRecordMappingAdapter as unknown as RecordMappingAdapter<TRecord>);
    this.events = options.events;
    this.defaultMaxRetries = options.defaultMaxRetries || 5;
  }

  async enqueue(
    type: string,
    payload: TPayload,
    options: EnqueueOptions = {}
  ): Promise<SyncOperation<TPayload>> {
    const id = options.id !== undefined ? options.id : generateUUID();
    const idempotencyKey = options.idempotencyKey || generateUUID();
    const createdAt = options.createdAt || new Date().toISOString();
    const maxRetries = options.maxRetries ?? this.defaultMaxRetries;

    const op: SyncOperation<TPayload> = {
      metadata: {
        id,
        idempotencyKey,
        type,
        createdAt,
        status: 'PENDING',
        retryCount: 0,
        maxRetries,
      },
      payload,
    };

    const storageRecord = this.mapping.toStorage(op as unknown as SyncOperation);
    await this.storage.put(id, storageRecord);

    this.events?.emit('operation:enqueued', { operation: op as unknown as SyncOperation });
    await this.emitQueueChange();

    return op;
  }

  async getById(id: StorageKey): Promise<SyncOperation<TPayload> | null> {
    const raw = await this.storage.get(id);
    if (!raw) return null;
    return this.mapping.fromStorage(raw as TRecord) as SyncOperation<TPayload>;
  }

  async getAll(): Promise<Array<SyncOperation<TPayload>>> {
    const rawRecords = await this.storage.getAll();
    return rawRecords.map((r) => this.mapping.fromStorage(r as TRecord) as SyncOperation<TPayload>);
  }

  async getPending(): Promise<Array<SyncOperation<TPayload>>> {
    const all = await this.getAll();
    return all
      .filter((op) => op.metadata.status === 'PENDING')
      .sort((a, b) => Date.parse(a.metadata.createdAt) - Date.parse(b.metadata.createdAt));
  }

  async getFailed(): Promise<Array<SyncOperation<TPayload>>> {
    const all = await this.getAll();
    return all.filter((op) => op.metadata.status === 'FAILED');
  }

  async getConflicts(): Promise<Array<SyncOperation<TPayload>>> {
    const all = await this.getAll();
    return all.filter((op) => op.metadata.status === 'CONFLICT');
  }

  async getCounts(): Promise<{ pendingCount: number; failedCount: number; conflictCount: number }> {
    const all = await this.getAll();
    let pendingCount = 0;
    let failedCount = 0;
    let conflictCount = 0;

    for (const op of all) {
      if (op.metadata.status === 'PENDING') pendingCount++;
      else if (op.metadata.status === 'FAILED') failedCount++;
      else if (op.metadata.status === 'CONFLICT') conflictCount++;
    }

    return { pendingCount, failedCount, conflictCount };
  }

  async emitQueueChange(): Promise<void> {
    if (!this.events) return;
    const counts = await this.getCounts();
    this.events.emit('queue:change', counts);
  }

  /**
   * Transition an operation status with atomic state machine checks.
   */
  async transitionStatus(
    id: StorageKey,
    targetStatus: SyncOperationStatus,
    updates: Partial<SyncOperation['metadata']> = {}
  ): Promise<SyncOperation<TPayload>> {
    const updatedRaw = await this.storage.atomicUpdate<TRecord>(id, (currentRaw) => {
      if (!currentRaw) {
        throw new Error(`Cannot transition operation '${id}': record not found`);
      }

      const op = this.mapping.fromStorage(currentRaw) as SyncOperation<TPayload>;
      assertValidTransition(op.metadata.status, targetStatus, id);

      // Merge metadata updates without touching immutable keys
      const updatedOp: SyncOperation<TPayload> = {
        ...op,
        metadata: {
          ...op.metadata,
          ...updates,
          id: op.metadata.id,
          idempotencyKey: op.metadata.idempotencyKey,
          type: op.metadata.type,
          createdAt: op.metadata.createdAt,
          status: targetStatus,
        },
      };

      return this.mapping.toStorage(updatedOp as unknown as SyncOperation);
    });

    const finalOp = this.mapping.fromStorage(updatedRaw) as SyncOperation<TPayload>;
    await this.emitQueueChange();
    return finalOp;
  }

  /**
   * Crash recovery: identifies and recovers stale operations left in SYNCING.
   * Only operations with demonstrably expired leases are recovered.
   * The original idempotencyKey is strictly preserved!
   */
  async recoverStaleSyncing(leaseConfig: LeaseConfig): Promise<number> {
    const all = await this.getAll();
    const now = Date.now();
    let recoveredCount = 0;

    for (const op of all) {
      if (op.metadata.status !== 'SYNCING') continue;

      let isStale = false;
      const leaseExpiresAt = op.metadata.leaseExpiresAt ? Date.parse(op.metadata.leaseExpiresAt) : NaN;
      const syncStartedAt = op.metadata.syncStartedAt ? Date.parse(op.metadata.syncStartedAt) : NaN;

      if (!isNaN(leaseExpiresAt)) {
        isStale = leaseExpiresAt < now;
      } else if (!isNaN(syncStartedAt)) {
        isStale = syncStartedAt + leaseConfig.leaseDurationMs < now;
      } else {
        // No lease timestamp recorded (e.g. legacy interrupted operation)
        isStale = true;
      }

      if (isStale) {
        await this.transitionStatus(op.metadata.id, 'PENDING', {
          syncStartedAt: undefined,
          leaseExpiresAt: undefined,
          lastError: 'Recovered after interrupted synchronization lease',
        });

        this.events?.emit('operation:recovered', {
          operation: op as unknown as SyncOperation,
          previousLeaseExpiresAt: op.metadata.leaseExpiresAt,
        });

        recoveredCount++;
      }
    }

    if (recoveredCount > 0) {
      await this.emitQueueChange();
    }

    return recoveredCount;
  }

  /**
   * Reset FAILED operations back to PENDING for manual retry.
   */
  async retryFailed(): Promise<number> {
    const failedOps = await this.getFailed();
    for (const op of failedOps) {
      await this.transitionStatus(op.metadata.id, 'PENDING', {
        retryCount: 0,
        lastError: undefined,
        lastErrorCode: undefined,
      });
    }
    return failedOps.length;
  }

  /**
   * Unblock operations paused by AUTH_BLOCKED after user re-authenticates.
   */
  async resumeAuth(): Promise<number> {
    const all = await this.getAll();
    const authBlocked = all.filter((op) => op.metadata.status === 'AUTH_BLOCKED');
    for (const op of authBlocked) {
      await this.transitionStatus(op.metadata.id, 'PENDING', {
        lastError: undefined,
        lastErrorCode: undefined,
      });
    }
    if (authBlocked.length > 0) {
      this.events?.emit('auth:resumed', undefined);
    }
    return authBlocked.length;
  }

  async delete(id: StorageKey): Promise<void> {
    await this.storage.delete(id);
    await this.emitQueueChange();
  }

  async clear(): Promise<void> {
    await this.storage.clear();
    await this.emitQueueChange();
  }
}
