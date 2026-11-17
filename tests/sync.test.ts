import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createOfflineSync, OfflineSyncClient } from '../src/client.js';
import type { ServerBatchResponse } from '../src/types/index.js';

describe('C. Synchronization Engine', () => {
  let client: OfflineSyncClient<any>;
  let mockOnSync: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockOnSync = vi.fn();
    client = createOfflineSync({
      storage: { type: 'memory' },
      onSync: mockOnSync,
      retry: {
        maxRetries: 3,
        initialDelayMs: 10,
        maxDelayMs: 50,
      },
    });
  });

  it('successfully synchronizes pending operations with itemized SUCCESS responses', async () => {
    const op = await client.enqueue('TEST_MUTATION', { item: 'notebook' });

    mockOnSync.mockResolvedValueOnce({
      success: true,
      results: [
        {
          idempotencyKey: op.metadata.idempotencyKey,
          status: 'SUCCESS',
        },
      ],
    } satisfies ServerBatchResponse);

    const summary = await client.syncNow();
    expect(summary.totalProcessed).toBe(1);
    expect(summary.syncedCount).toBe(1);
    expect(summary.failedCount).toBe(0);

    const stored = await client.getById(op.metadata.id);
    expect(stored?.metadata.status).toBe('SYNCED');
  });

  it('marks operations as SYNCED without error on DUPLICATE_IDEMPOTENT responses', async () => {
    const op = await client.enqueue('CREATE_RECORD', { id: 123 });

    mockOnSync.mockResolvedValueOnce({
      success: true,
      results: [
        {
          idempotencyKey: op.metadata.idempotencyKey,
          status: 'DUPLICATE_IDEMPOTENT',
        },
      ],
    } satisfies ServerBatchResponse);

    const summary = await client.syncNow();
    expect(summary.duplicatesCount).toBe(1);
    expect(summary.failedCount).toBe(0);

    const stored = await client.getById(op.metadata.id);
    expect(stored?.metadata.status).toBe('SYNCED');
  });

  it('handles partial batch results with heterogeneous statuses', async () => {
    const op1 = await client.enqueue('ITEM_1', { idx: 1 });
    const op2 = await client.enqueue('ITEM_2', { idx: 2 });
    const op3 = await client.enqueue('ITEM_3', { idx: 3 });

    mockOnSync.mockResolvedValueOnce({
      success: true,
      results: [
        { idempotencyKey: op1.metadata.idempotencyKey, status: 'SUCCESS' },
        { idempotencyKey: op2.metadata.idempotencyKey, status: 'RETRYABLE_ERROR', error: 'Lock timeout' },
        { idempotencyKey: op3.metadata.idempotencyKey, status: 'PERMANENT_ERROR', error: 'Validation failed' },
      ],
    } satisfies ServerBatchResponse);

    const summary = await client.syncNow();
    expect(summary.syncedCount).toBe(1);
    expect(summary.retryableCount).toBe(1);
    expect(summary.failedCount).toBe(1);

    const stored1 = await client.getById(op1.metadata.id);
    const stored2 = await client.getById(op2.metadata.id);
    const stored3 = await client.getById(op3.metadata.id);

    expect(stored1?.metadata.status).toBe('SYNCED');
    expect(stored2?.metadata.status).toBe('PENDING'); // back in queue for retry
    expect(stored2?.metadata.retryCount).toBe(1);
    expect(stored3?.metadata.status).toBe('FAILED');  // permanent failure
  });

  it('exhausts retry budget and transitions to FAILED on persistent RETRYABLE_ERROR', async () => {
    const op = await client.enqueue('TRANSIENT_TASK', { foo: 'bar' });

    for (let i = 0; i < 3; i++) {
      mockOnSync.mockResolvedValueOnce({
        success: false,
        results: [
          { idempotencyKey: op.metadata.idempotencyKey, status: 'RETRYABLE_ERROR', error: 'Database busy' },
        ],
      } satisfies ServerBatchResponse);

      await client.syncNow();
    }

    const stored = await client.getById(op.metadata.id);
    expect(stored?.metadata.status).toBe('FAILED');
    expect(stored?.metadata.retryCount).toBe(3);
  });

  it('isolates CONFLICT operations and preserves conflict details without data loss', async () => {
    const op = await client.enqueue('UPDATE_STATUS', { newStatus: 'PRESENT' });

    mockOnSync.mockResolvedValueOnce({
      success: true,
      results: [
        {
          idempotencyKey: op.metadata.idempotencyKey,
          status: 'CONFLICT',
          conflictDetails: { serverState: 'ABSENT', reason: 'Marked absent by administrator' },
        },
      ],
    } satisfies ServerBatchResponse);

    const summary = await client.syncNow();
    expect(summary.conflictsCount).toBe(1);

    const stored = await client.getById(op.metadata.id);
    expect(stored?.metadata.status).toBe('CONFLICT');
    expect(stored?.metadata.conflictData).toEqual({
      serverState: 'ABSENT',
      reason: 'Marked absent by administrator',
    });
  });

  it('halts queue and sets AUTH_BLOCKED on HTTP 401 Unauthorized', async () => {
    const op1 = await client.enqueue('SECURE_ACTION_1', {});
    const op2 = await client.enqueue('SECURE_ACTION_2', {});

    const authError = new Error('Session Expired');
    (authError as any).response = { status: 401 };

    mockOnSync.mockRejectedValueOnce(authError);

    let authExpiredEmitted = false;
    client.on('auth:expired', () => {
      authExpiredEmitted = true;
    });

    const summary = await client.syncNow();
    expect(summary.authBlocked).toBe(true);
    expect(authExpiredEmitted).toBe(true);

    const stored1 = await client.getById(op1.metadata.id);
    const stored2 = await client.getById(op2.metadata.id);
    expect(stored1?.metadata.status).toBe('AUTH_BLOCKED');
    expect(stored2?.metadata.status).toBe('AUTH_BLOCKED');

    // Subsequent syncNow calls should skip AUTH_BLOCKED operations
    mockOnSync.mockClear();
    const secondSummary = await client.syncNow();
    expect(secondSummary.totalProcessed).toBe(0);
    expect(mockOnSync).not.toHaveBeenCalled();

    // After re-authentication, resumeSync() unblocks them
    mockOnSync.mockResolvedValueOnce({
      success: true,
      results: [
        { idempotencyKey: op1.metadata.idempotencyKey, status: 'SUCCESS' },
        { idempotencyKey: op2.metadata.idempotencyKey, status: 'SUCCESS' },
      ],
    } satisfies ServerBatchResponse);

    await client.resumeSync();
    const storedAfter = await client.getById(op1.metadata.id);
    expect(storedAfter?.metadata.status).toBe('SYNCED');
  });

  it('handles HTTP 429 Rate Limiting and respects Retry-After cooldown', async () => {
    const op = await client.enqueue('RATE_LIMITED_TASK', {});

    const rateLimitError = new Error('Too Many Requests');
    (rateLimitError as any).response = {
      status: 429,
      headers: { 'retry-after': '60' },
    };

    mockOnSync.mockRejectedValueOnce(rateLimitError);

    const summary = await client.syncNow();
    expect(summary.retryAfterSeconds).toBe(60);

    const stored = await client.getById(op.metadata.id);
    expect(stored?.metadata.status).toBe('PENDING'); // Kept in pending for cooldown
  });
});
