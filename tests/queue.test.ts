import { describe, it, expect, beforeEach } from 'vitest';
import { SyncQueue } from '../src/queue.js';
import { MemoryStorageAdapter } from '../src/storage/memory.js';
import { IllegalStateTransitionError } from '../src/errors.js';

describe('A. SyncQueue', () => {
  let storage: MemoryStorageAdapter;
  let queue: SyncQueue<{ message: string }>;

  beforeEach(() => {
    storage = new MemoryStorageAdapter();
    queue = new SyncQueue<{ message: string }>({ storage });
  });

  it('enqueues an operation with valid metadata and PENDING status', async () => {
    const op = await queue.enqueue('TEST_ACTION', { message: 'hello' });

    expect(op.metadata.id).toBeDefined();
    expect(op.metadata.idempotencyKey).toBeDefined();
    expect(op.metadata.status).toBe('PENDING');
    expect(op.metadata.type).toBe('TEST_ACTION');
    expect(op.metadata.retryCount).toBe(0);
    expect(op.payload.message).toBe('hello');

    const retrieved = await queue.getById(op.metadata.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.payload.message).toBe('hello');
  });

  it('retrieves all pending operations sorted by creation timestamp', async () => {
    await queue.enqueue('ACTION_1', { message: 'first' }, { createdAt: '2026-01-01T10:00:00Z' });
    await queue.enqueue('ACTION_2', { message: 'second' }, { createdAt: '2026-01-01T09:00:00Z' });

    const pending = await queue.getPending();
    expect(pending.length).toBe(2);
    expect(pending[0]?.payload.message).toBe('second');
    expect(pending[1]?.payload.message).toBe('first');
  });

  it('retrieves all operations regardless of status', async () => {
    const op1 = await queue.enqueue('ACTION_1', { message: 'one' });
    const op2 = await queue.enqueue('ACTION_2', { message: 'two' });

    await queue.transitionStatus(op1.metadata.id, 'SYNCING');
    await queue.transitionStatus(op1.metadata.id, 'SYNCED');

    const all = await queue.getAll();
    expect(all.length).toBe(2);

    const pending = await queue.getPending();
    expect(pending.length).toBe(1);
    expect(pending[0]?.metadata.id).toBe(op2.metadata.id);
  });

  it('resets failed operations back to PENDING on retryFailed()', async () => {
    const op = await queue.enqueue('ACTION_1', { message: 'retry me' });
    await queue.transitionStatus(op.metadata.id, 'SYNCING');
    await queue.transitionStatus(op.metadata.id, 'FAILED', { lastError: 'Fatal 500' });

    let failed = await queue.getFailed();
    expect(failed.length).toBe(1);

    const retriedCount = await queue.retryFailed();
    expect(retriedCount).toBe(1);

    failed = await queue.getFailed();
    expect(failed.length).toBe(0);

    const pending = await queue.getPending();
    expect(pending.length).toBe(1);
    expect(pending[0]?.metadata.status).toBe('PENDING');
    expect(pending[0]?.metadata.retryCount).toBe(0);
  });

  it('throws IllegalStateTransitionError on forbidden state transitions', async () => {
    const op = await queue.enqueue('ACTION_1', { message: 'test' });

    // PENDING cannot jump directly to SYNCED
    await expect(queue.transitionStatus(op.metadata.id, 'SYNCED')).rejects.toThrow(
      IllegalStateTransitionError
    );

    // Transition properly: PENDING -> SYNCING -> SYNCED
    await queue.transitionStatus(op.metadata.id, 'SYNCING');
    await queue.transitionStatus(op.metadata.id, 'SYNCED');

    // SYNCED is terminal, cannot transition back to PENDING
    await expect(queue.transitionStatus(op.metadata.id, 'PENDING')).rejects.toThrow(
      IllegalStateTransitionError
    );
  });
});
