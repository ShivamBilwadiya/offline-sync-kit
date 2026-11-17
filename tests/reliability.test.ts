import { describe, it, expect, vi } from 'vitest';
import { createOfflineSync } from '../src/client.js';
import { FallbackIndexedDBLockManager } from '../src/locks/fallback-indexeddb.js';
import { WebLocksManager } from '../src/locks/web-locks.js';
import { MemoryStorageAdapter } from '../src/storage/memory.js';
import { SyncQueue } from '../src/queue.js';

describe('D. Reliability & Concurrency', () => {
  it('recovers crashed operations left in SYNCING without altering idempotencyKey', async () => {
    const storage = new MemoryStorageAdapter();
    const queue = new SyncQueue<any>({ storage });

    const op = await queue.enqueue('CRASH_TEST', { step: 1 });
    const originalIdempotencyKey = op.metadata.idempotencyKey;

    // Simulate an interrupted operation with an expired lease (e.g. 2 minutes in the past)
    const expiredTimestamp = new Date(Date.now() - 120000).toISOString();
    await queue.transitionStatus(op.metadata.id, 'SYNCING', {
      syncStartedAt: expiredTimestamp,
      leaseExpiresAt: expiredTimestamp,
    });

    const syncingBefore = (await queue.getAll()).filter((o) => o.metadata.status === 'SYNCING');
    expect(syncingBefore.length).toBe(1);

    // Run recovery with lease duration of 60 seconds
    const recoveredCount = await queue.recoverStaleSyncing({ leaseDurationMs: 60000 });
    expect(recoveredCount).toBe(1);

    const recovered = await queue.getById(op.metadata.id);
    expect(recovered?.metadata.status).toBe('PENDING');
    // Critical: idempotencyKey must remain identical!
    expect(recovered?.metadata.idempotencyKey).toBe(originalIdempotencyKey);
  });

  it('does NOT reset active SYNCING operations whose leases have not expired', async () => {
    const storage = new MemoryStorageAdapter();
    const queue = new SyncQueue<any>({ storage });

    const op = await queue.enqueue('ACTIVE_TEST', { step: 1 });
    const activeTimestamp = new Date(Date.now() + 50000).toISOString(); // expires in 50s

    await queue.transitionStatus(op.metadata.id, 'SYNCING', {
      leaseExpiresAt: activeTimestamp,
    });

    const recoveredCount = await queue.recoverStaleSyncing({ leaseDurationMs: 60000 });
    expect(recoveredCount).toBe(0);

    const check = await queue.getById(op.metadata.id);
    expect(check?.metadata.status).toBe('SYNCING');
  });

  it('provides mutual exclusion across concurrent sync requests via FallbackIndexedDBLockManager', async () => {
    const lockDbName = 'test_fallback_lock_' + Math.random().toString(36).substring(2, 7);
    const lock1 = new FallbackIndexedDBLockManager({ lockDbName, leaseDurationMs: 5000 });
    const lock2 = new FallbackIndexedDBLockManager({ lockDbName, leaseDurationMs: 5000 });

    let activeExecutions = 0;
    let maxSimultaneous = 0;

    const criticalWork = async () => {
      activeExecutions++;
      maxSimultaneous = Math.max(maxSimultaneous, activeExecutions);
      await new Promise((r) => setTimeout(r, 100));
      activeExecutions--;
    };

    // Both clients attempt to acquire the same lock simultaneously
    await Promise.all([
      lock1.withLock('shared_resource', criticalWork),
      lock2.withLock('shared_resource', criticalWork),
    ]);

    expect(maxSimultaneous).toBe(1);
    await lock1.destroy();
    await lock2.destroy();
  });

  it('WebLocksManager works in environments supporting navigator.locks', async () => {
    if (typeof navigator !== 'undefined' && 'locks' in navigator) {
      const lockManager = new WebLocksManager();
      let ran = false;

      await lockManager.withLock('test-web-lock', async (session) => {
        expect(session.lockName).toBe('test-web-lock');
        expect(session.abortSignal.aborted).toBe(false);
        ran = true;
      });

      expect(ran).toBe(true);
    }
  });

  it('prevents multi-client double dispatch against the same storage database', async () => {
    const sharedStorage = new MemoryStorageAdapter();
    const mockOnSync = vi.fn().mockImplementation(async (batch) => {
      await new Promise((r) => setTimeout(r, 80));
      return {
        success: true,
        results: batch.map((op: any) => ({
          idempotencyKey: op.metadata.idempotencyKey,
          status: 'SUCCESS',
        })),
      };
    });

    const client1 = createOfflineSync({
      storage: { customAdapter: sharedStorage },
      onSync: mockOnSync,
    });

    const client2 = createOfflineSync({
      storage: { customAdapter: sharedStorage },
      onSync: mockOnSync,
    });

    await client1.enqueue('TASK_1', {});
    await client1.enqueue('TASK_2', {});

    // Trigger syncNow simultaneously from both clients
    await Promise.all([client1.syncNow(), client2.syncNow()]);

    // Only one execution should run the batches, preventing duplicate sends
    expect(mockOnSync).toHaveBeenCalledTimes(1);

    await client1.destroy();
    await client2.destroy();
  });
});
