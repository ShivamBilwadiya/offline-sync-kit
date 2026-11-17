import type {
  SyncOperation,
  SyncSummary,
  ServerBatchResponse,
  ServerBatchItemResult,
  RetryPolicy,
  LeaseConfig,
  ConflictResolver,
  ClassifiedError,
} from './types/index.js';
import type { SyncQueue } from './queue.js';
import type { LockManager, LockSession } from './locks/interface.js';
import { DEFAULT_RETRY_POLICY } from './utils/backoff.js';
import { classifyHttpError } from './utils/error-classifier.js';
import { LockLostError } from './errors.js';
import type { TypedEventEmitter } from './utils/events.js';

export interface SyncDispatcherOptions<TPayload = unknown, TRecord = unknown> {
  queue: SyncQueue<TPayload, TRecord>;
  lockManager: LockManager;
  lockName?: string;
  batchSize?: number;
  retryPolicy?: Partial<RetryPolicy>;
  leaseConfig?: Partial<LeaseConfig>;
  cleanupStrategy?: 'keep' | 'delete';
  conflictResolver?: ConflictResolver<TPayload>;
  classifyError?: (error: unknown, operation?: SyncOperation<TPayload>) => ClassifiedError | undefined;
  events?: TypedEventEmitter;
  onSync: (
    batch: Array<SyncOperation<TPayload>>,
    abortSignal: AbortSignal
  ) => Promise<ServerBatchResponse>;
}

export class SyncDispatcher<TPayload = unknown, TRecord = unknown> {
  private readonly queue: SyncQueue<TPayload, TRecord>;
  private readonly lockManager: LockManager;
  private readonly lockName: string;
  private readonly batchSize: number;
  private readonly retryPolicy: RetryPolicy;
  private readonly leaseConfig: LeaseConfig;
  private readonly cleanupStrategy: 'keep' | 'delete';
  private readonly conflictResolver?: ConflictResolver<TPayload>;
  private readonly customClassifier?: (error: unknown, op?: SyncOperation<TPayload>) => ClassifiedError | undefined;
  private readonly events?: TypedEventEmitter;
  private readonly onSync: (
    batch: Array<SyncOperation<TPayload>>,
    abortSignal: AbortSignal
  ) => Promise<ServerBatchResponse>;

  constructor(options: SyncDispatcherOptions<TPayload, TRecord>) {
    this.queue = options.queue;
    this.lockManager = options.lockManager;
    this.lockName = options.lockName || 'offline-sync-kit:main-sync-lock';
    this.batchSize = options.batchSize || 25;
    this.retryPolicy = { ...DEFAULT_RETRY_POLICY, ...options.retryPolicy };
    this.leaseConfig = { leaseDurationMs: options.leaseConfig?.leaseDurationMs || 60000 };
    this.cleanupStrategy = options.cleanupStrategy || 'keep';
    this.conflictResolver = options.conflictResolver;
    this.customClassifier = options.classifyError;
    this.events = options.events;
    this.onSync = options.onSync;
  }

  getRetryPolicy(): RetryPolicy {
    return { ...this.retryPolicy };
  }

  async dispatch(options: { forceManualRetry?: boolean } = {}): Promise<SyncSummary> {
    return await this.lockManager.withLock(this.lockName, async (session: LockSession) => {
      this.events?.emit('lock:acquired', { lockName: session.lockName, ownerId: session.ownerId });

      try {
        return await this.executeSyncCycle(session, options.forceManualRetry || false);
      } finally {
        // Lock release is handled by lockManager
      }
    });
  }

  private async executeSyncCycle(session: LockSession, forceManualRetry: boolean): Promise<SyncSummary> {
    const summary: SyncSummary = {
      totalProcessed: 0,
      syncedCount: 0,
      duplicatesCount: 0,
      conflictsCount: 0,
      failedCount: 0,
      retryableCount: 0,
      authBlocked: false,
    };

    // 1. Crash recovery sweep for stale leases
    await this.queue.recoverStaleSyncing(this.leaseConfig);

    // 2. Fetch items to process
    if (forceManualRetry) {
      await this.queue.retryFailed();
    }

    const pending = await this.queue.getPending();
    if (pending.length === 0) {
      return summary;
    }

    this.events?.emit('sync:start', { count: pending.length });

    // 3. Process in batches
    for (let i = 0; i < pending.length; i += this.batchSize) {
      if (session.abortSignal.aborted) {
        throw new LockLostError(this.lockName, 'Aborted due to lost synchronization lock.');
      }

      const batch = pending.slice(i, i + this.batchSize);
      await this.processBatch(batch, session, summary);

      if (summary.authBlocked) {
        break; // Stop subsequent batches when authentication is expired
      }

      if (summary.networkOffline) {
        break; // Stop subsequent batches when offline
      }

      if (summary.retryAfterSeconds !== undefined && summary.retryAfterSeconds > 0) {
        break; // Rate limited; halt until cooldown
      }
    }

    this.events?.emit('sync:success', summary);
    return summary;
  }

  private async processBatch(
    batch: Array<SyncOperation<TPayload>>,
    session: LockSession,
    summary: SyncSummary
  ): Promise<void> {
    const now = Date.now();
    const syncStartedAt = new Date(now).toISOString();
    const leaseExpiresAt = new Date(now + this.leaseConfig.leaseDurationMs).toISOString();

    // Mark operations as SYNCING with lease timestamps
    for (const op of batch) {
      await this.queue.transitionStatus(op.metadata.id, 'SYNCING', {
        syncStartedAt,
        leaseExpiresAt,
      });
    }

    let response: ServerBatchResponse;

    try {
      response = await this.onSync(batch, session.abortSignal);
    } catch (error) {
      await this.handleBatchTransportFailure(batch, error, summary);
      return;
    }

    // Process itemized server results
    await this.handleServerResults(batch, response, summary);
  }

  private async handleServerResults(
    batch: Array<SyncOperation<TPayload>>,
    response: ServerBatchResponse,
    summary: SyncSummary
  ): Promise<void> {
    const resultsMap = new Map<string, ServerBatchItemResult>();
    if (Array.isArray(response.results)) {
      for (const res of response.results) {
        if (res.idempotencyKey) {
          resultsMap.set(res.idempotencyKey, res);
        }
      }
    }

    for (const op of batch) {
      summary.totalProcessed++;
      const result = resultsMap.get(op.metadata.idempotencyKey);

      // If server did not return result for this specific item, treat as retryable
      if (!result) {
        await this.handleRetryableItem(op, 'Missing server item result in batch response', summary);
        continue;
      }

      switch (result.status) {
        case 'SUCCESS':
        case 'DUPLICATE_IDEMPOTENT': {
          const isDuplicate = result.status === 'DUPLICATE_IDEMPOTENT';
          if (isDuplicate) {
            summary.duplicatesCount++;
          } else {
            summary.syncedCount++;
          }

          if (this.cleanupStrategy === 'delete') {
            await this.queue.delete(op.metadata.id);
          } else {
            await this.queue.transitionStatus(op.metadata.id, 'SYNCED', {
              lastError: undefined,
              lastErrorCode: undefined,
              syncStartedAt: undefined,
              leaseExpiresAt: undefined,
            });
          }

          this.events?.emit('operation:synced', {
            operation: op as unknown as SyncOperation,
            isDuplicate,
          });
          break;
        }

        case 'CONFLICT': {
          summary.conflictsCount++;
          await this.handleConflictItem(op, result, summary);
          break;
        }

        case 'RETRYABLE_ERROR': {
          await this.handleRetryableItem(op, result.error || 'Retryable server failure', summary);
          break;
        }

        case 'PERMANENT_ERROR':
        default: {
          summary.failedCount++;
          await this.queue.transitionStatus(op.metadata.id, 'FAILED', {
            lastError: result.error || 'Permanent server rejection',
            lastErrorCode: result.errorCode,
            syncStartedAt: undefined,
            leaseExpiresAt: undefined,
          });
          this.events?.emit('operation:failed', {
            operation: op as unknown as SyncOperation,
            error: result.error,
          });
          break;
        }
      }
    }
  }

  private async handleConflictItem(
    op: SyncOperation<TPayload>,
    result: ServerBatchItemResult,
    summary: SyncSummary
  ): Promise<void> {
    if (this.conflictResolver) {
      try {
        const resolution = await this.conflictResolver({
          operation: op,
          conflictDetails: result.conflictDetails,
        });

        if (resolution.action === 'KEEP_CLIENT') {
          // Re-queue with incremented retry count
          await this.queue.transitionStatus(op.metadata.id, 'PENDING', {
            conflictData: result.conflictDetails,
            syncStartedAt: undefined,
            leaseExpiresAt: undefined,
          });
          return;
        }

        if (resolution.action === 'ACCEPT_SERVER' || resolution.action === 'MARK_RESOLVED') {
          await this.queue.transitionStatus(op.metadata.id, 'SYNCED', {
            conflictData: result.conflictDetails,
            syncStartedAt: undefined,
            leaseExpiresAt: undefined,
          });
          summary.syncedCount++;
          return;
        }
      } catch (resolverErr) {
        console.error(`Conflict resolver failed for operation '${op.metadata.id}':`, resolverErr);
      }
    }

    // Default behavior: isolate in CONFLICT state without data loss
    await this.queue.transitionStatus(op.metadata.id, 'CONFLICT', {
      conflictData: result.conflictDetails,
      syncStartedAt: undefined,
      leaseExpiresAt: undefined,
      lastError: result.error || 'Server conflict detected',
    });

    this.events?.emit('operation:conflict', {
      operation: op as unknown as SyncOperation,
      conflictDetails: result.conflictDetails,
    });
  }

  private async handleRetryableItem(
    op: SyncOperation<TPayload>,
    errorMessage: string,
    summary: SyncSummary
  ): Promise<void> {
    const nextRetry = op.metadata.retryCount + 1;

    if (nextRetry >= op.metadata.maxRetries) {
      summary.failedCount++;
      await this.queue.transitionStatus(op.metadata.id, 'FAILED', {
        retryCount: nextRetry,
        lastError: `Exhausted maximum retries (${op.metadata.maxRetries}): ${errorMessage}`,
        syncStartedAt: undefined,
        leaseExpiresAt: undefined,
      });
      this.events?.emit('operation:failed', {
        operation: op as unknown as SyncOperation,
        error: errorMessage,
      });
    } else {
      summary.retryableCount++;
      await this.queue.transitionStatus(op.metadata.id, 'PENDING', {
        retryCount: nextRetry,
        lastError: errorMessage,
        syncStartedAt: undefined,
        leaseExpiresAt: undefined,
      });
    }
  }

  private async handleBatchTransportFailure(
    batch: Array<SyncOperation<TPayload>>,
    error: unknown,
    summary: SyncSummary
  ): Promise<void> {
    const classified = this.customClassifier
      ? (this.customClassifier(error) || classifyHttpError(error))
      : classifyHttpError(error);

    this.events?.emit('sync:error', { error: error as Error, summary });

    // HTTP 401 Unauthorized: halt queue
    if (classified.category === 'AUTH_EXPIRED') {
      summary.authBlocked = true;
      for (const op of batch) {
        summary.totalProcessed++;
        await this.queue.transitionStatus(op.metadata.id, 'AUTH_BLOCKED', {
          lastError: classified.message,
          lastErrorCode: '401_UNAUTHORIZED',
          syncStartedAt: undefined,
          leaseExpiresAt: undefined,
        });
      }
      this.events?.emit('auth:expired', { error: classified });
      return;
    }

    // HTTP 429 Rate limited: record cooldown
    if (classified.category === 'RATE_LIMITED') {
      summary.retryAfterSeconds = classified.retryAfterSeconds;
      for (const op of batch) {
        summary.totalProcessed++;
        await this.queue.transitionStatus(op.metadata.id, 'PENDING', {
          lastError: classified.message,
          lastErrorCode: '429_RATE_LIMITED',
          syncStartedAt: undefined,
          leaseExpiresAt: undefined,
        });
      }
      return;
    }

    // True network offline: reset to PENDING without consuming retries
    if (classified.category === 'NETWORK_OFFLINE') {
      summary.networkOffline = true;
      for (const op of batch) {
        summary.totalProcessed++;
        await this.queue.transitionStatus(op.metadata.id, 'PENDING', {
          lastError: classified.message,
          syncStartedAt: undefined,
          leaseExpiresAt: undefined,
        });
      }
      return;
    }

    // HTTP 403 or 400/422 Client validation: permanent failure
    if (classified.category === 'PERMISSION_DENIED' || classified.category === 'CLIENT_VALIDATION') {
      for (const op of batch) {
        summary.totalProcessed++;
        summary.failedCount++;
        await this.queue.transitionStatus(op.metadata.id, 'FAILED', {
          lastError: classified.message,
          lastErrorCode: classified.category,
          syncStartedAt: undefined,
          leaseExpiresAt: undefined,
        });
        this.events?.emit('operation:failed', {
          operation: op as unknown as SyncOperation,
          error: classified.message,
        });
      }
      return;
    }

    // Server errors (5xx) or timeouts (408): retry with backoff
    for (const op of batch) {
      summary.totalProcessed++;
      await this.handleRetryableItem(op, classified.message, summary);
    }
  }
}
