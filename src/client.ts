import type {
  SyncOperation,
  StorageKey,
  EnqueueOptions,
  SyncSummary,
  ServerBatchResponse,
  RetryPolicy,
  LeaseConfig,
  ConflictResolver,
  ConflictResolution,
  ClassifiedError,
  SyncEventMap,
  SyncEventHandler,
} from './types/index.js';
import type { StorageAdapter, RecordMappingAdapter } from './storage/interface.js';
import { IndexedDBStorageAdapter } from './storage/indexeddb.js';
import { MemoryStorageAdapter } from './storage/memory.js';
import { SyncQueue } from './queue.js';
import { SyncDispatcher } from './dispatcher.js';
import { createLockManager, LockManager } from './locks/index.js';
import { BrowserNetworkDetector, NetworkDetector } from './network/detector.js';
import { TypedEventEmitter } from './utils/events.js';

export interface StorageConfig<TRecord = unknown> {
  type?: 'indexeddb' | 'memory';
  dbName?: string;
  storeName?: string;
  version?: number;
  keyPath?: string;
  customAdapter?: StorageAdapter;
  mapping?: RecordMappingAdapter<TRecord>;
}

export interface OfflineSyncConfig<TPayload = unknown, TRecord = unknown> {
  storage?: StorageConfig<TRecord>;
  batchSize?: number;
  retry?: Partial<RetryPolicy>;
  lease?: Partial<LeaseConfig>;
  lockName?: string;
  lockManager?: LockManager;
  preferWebLocks?: boolean;
  cleanupStrategy?: 'keep' | 'delete';
  autoSyncOnOnline?: boolean;
  networkDetector?: NetworkDetector;
  conflictResolver?: ConflictResolver<TPayload>;
  classifyError?: (error: unknown, op?: SyncOperation<TPayload>) => ClassifiedError | undefined;
  onSync: (
    batch: Array<SyncOperation<TPayload>>,
    abortSignal: AbortSignal
  ) => Promise<ServerBatchResponse>;
}

export class OfflineSyncClient<TPayload = unknown, TRecord = unknown> {
  private readonly storage: StorageAdapter;
  private readonly queue: SyncQueue<TPayload, TRecord>;
  private readonly dispatcher: SyncDispatcher<TPayload, TRecord>;
  private readonly lockManager: LockManager;
  private readonly networkDetector: NetworkDetector;
  private readonly events = new TypedEventEmitter();
  private networkUnsubscribe?: () => void;
  private destroyed = false;
  private refCount = 0;
  private pendingDestroyTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: OfflineSyncConfig<TPayload, TRecord>) {
    // 1. Initialize Storage Adapter
    const storageConfig = config.storage || {};
    if (storageConfig.customAdapter) {
      this.storage = storageConfig.customAdapter;
    } else if (storageConfig.type === 'memory' || typeof indexedDB === 'undefined') {
      this.storage = new MemoryStorageAdapter();
    } else {
      this.storage = new IndexedDBStorageAdapter({
        dbName: storageConfig.dbName || 'offline_sync_kit_db',
        storeName: storageConfig.storeName || 'operations',
        version: storageConfig.version,
        keyPath: storageConfig.keyPath || 'id',
      });
    }

    // 2. Initialize Queue
    this.queue = new SyncQueue<TPayload, TRecord>({
      storage: this.storage,
      mapping: storageConfig.mapping,
      events: this.events,
      defaultMaxRetries: config.retry?.maxRetries || 5,
    });

    // 3. Initialize Lock Manager
    this.lockManager =
      config.lockManager ||
      createLockManager({
        preferWebLocks: config.preferWebLocks !== false,
      });

    // 4. Initialize Dispatcher
    this.dispatcher = new SyncDispatcher<TPayload, TRecord>({
      queue: this.queue,
      lockManager: this.lockManager,
      lockName: config.lockName,
      batchSize: config.batchSize,
      retryPolicy: config.retry,
      leaseConfig: config.lease,
      cleanupStrategy: config.cleanupStrategy || 'keep',
      conflictResolver: config.conflictResolver,
      classifyError: config.classifyError,
      events: this.events,
      onSync: config.onSync,
    });

    // 5. Network Auto-Sync
    this.networkDetector = config.networkDetector || new BrowserNetworkDetector();
    if (config.autoSyncOnOnline !== false) {
      this.networkUnsubscribe = this.networkDetector.subscribe((isOnline) => {
        this.events.emit('network:change', { isOnline });
        if (isOnline && !this.destroyed) {
          this.syncNow().catch((err) => {
            console.error('Auto-sync on network restoration failed:', err);
          });
        }
      });
    }
  }

  async enqueue(
    type: string,
    payload: TPayload,
    options?: EnqueueOptions
  ): Promise<SyncOperation<TPayload>> {
    this.assertNotDestroyed();
    return await this.queue.enqueue(type, payload, options);
  }

  async getPending(): Promise<Array<SyncOperation<TPayload>>> {
    this.assertNotDestroyed();
    return await this.queue.getPending();
  }

  async getAll(): Promise<Array<SyncOperation<TPayload>>> {
    this.assertNotDestroyed();
    return await this.queue.getAll();
  }

  async getById(id: StorageKey): Promise<SyncOperation<TPayload> | null> {
    this.assertNotDestroyed();
    return await this.queue.getById(id);
  }

  async getCounts(): Promise<{ pendingCount: number; failedCount: number; conflictCount: number }> {
    this.assertNotDestroyed();
    return await this.queue.getCounts();
  }

  async syncNow(): Promise<SyncSummary> {
    this.assertNotDestroyed();
    return await this.dispatcher.dispatch();
  }

  async retryFailed(): Promise<SyncSummary> {
    this.assertNotDestroyed();
    return await this.dispatcher.dispatch({ forceManualRetry: true });
  }

  async resumeSync(): Promise<number> {
    this.assertNotDestroyed();
    const count = await this.queue.resumeAuth();
    if (count > 0) {
      await this.syncNow();
    }
    return count;
  }

  async resolveConflict(id: StorageKey, resolution: ConflictResolution<TPayload>): Promise<void> {
    this.assertNotDestroyed();
    const op = await this.queue.getById(id);
    if (!op) {
      throw new Error(`Cannot resolve conflict: operation '${id}' not found`);
    }

    if (resolution.action === 'KEEP_CLIENT') {
      await this.queue.transitionStatus(id, 'PENDING', {
        conflictData: undefined,
        lastError: undefined,
      });
    } else if (resolution.action === 'ACCEPT_SERVER' || resolution.action === 'MARK_RESOLVED') {
      await this.queue.transitionStatus(id, 'SYNCED', {
        conflictData: undefined,
        lastError: undefined,
      });
    } else if (resolution.action === 'MANUAL_DEFER') {
      // Retain in CONFLICT
    }
  }

  on<K extends keyof SyncEventMap>(
    event: K,
    listener: SyncEventHandler<SyncEventMap[K]>
  ): () => void {
    this.assertNotDestroyed();
    return this.events.on(event, listener);
  }

  isOnline(): boolean {
    return this.networkDetector.isOnline();
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  retain(): void {
    this.assertNotDestroyed();
    this.refCount++;
    if (this.pendingDestroyTimer) {
      clearTimeout(this.pendingDestroyTimer);
      this.pendingDestroyTimer = null;
    }
  }

  release(delayMs = 150): void {
    this.refCount = Math.max(0, this.refCount - 1);
    if (this.refCount === 0 && !this.destroyed) {
      if (this.pendingDestroyTimer) {
        clearTimeout(this.pendingDestroyTimer);
      }
      this.pendingDestroyTimer = setTimeout(() => {
        this.pendingDestroyTimer = null;
        if (this.refCount === 0 && !this.destroyed) {
          this.destroy().catch((err) => {
            console.error("Error during deferred client destroy:", err);
          });
        }
      }, delayMs);
    }
  }

  async destroy(): Promise<void> {
    if (this.pendingDestroyTimer) {
      clearTimeout(this.pendingDestroyTimer);
      this.pendingDestroyTimer = null;
    }
    if (this.destroyed) return;
    this.destroyed = true;

    if (this.networkUnsubscribe) {
      this.networkUnsubscribe();
    }
    this.events.removeAllListeners();

    if (this.lockManager.destroy) {
      await this.lockManager.destroy();
    }
    if (this.storage.close) {
      await this.storage.close();
    }
  }

  private assertNotDestroyed(): void {
    if (this.destroyed) {
      throw new Error('OfflineSyncClient instance has been destroyed.');
    }
  }
}

export function createOfflineSync<TPayload = unknown, TRecord = unknown>(
  config: OfflineSyncConfig<TPayload, TRecord>
): OfflineSyncClient<TPayload, TRecord> {
  return new OfflineSyncClient<TPayload, TRecord>(config);
}
