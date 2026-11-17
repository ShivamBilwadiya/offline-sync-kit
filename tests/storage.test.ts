import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStorageAdapter } from '../src/storage/memory.js';
import { IndexedDBStorageAdapter } from '../src/storage/indexeddb.js';

describe('B. Storage Adapters', () => {
  describe('MemoryStorageAdapter', () => {
    let memory: MemoryStorageAdapter;

    beforeEach(() => {
      memory = new MemoryStorageAdapter();
    });

    it('stores, retrieves, and deletes records', async () => {
      await memory.put('k1', { val: 'abc' });
      const record = await memory.get('k1');
      expect(record).toEqual({ val: 'abc' });

      await memory.delete('k1');
      const deleted = await memory.get('k1');
      expect(deleted).toBeNull();
    });

    it('performs atomic record updates safely', async () => {
      await memory.put('counter', { count: 1 });

      const updated = await memory.atomicUpdate<{ count: number }>('counter', (current) => {
        return { count: (current?.count || 0) + 1 };
      });

      expect(updated.count).toBe(2);
      const readBack = (await memory.get('counter')) as { count: number };
      expect(readBack.count).toBe(2);
    });

    it('rolls back transaction on error', async () => {
      await memory.put('account', { balance: 100 });

      await expect(
        memory.transaction('readwrite', async (tx) => {
          await tx.put('account', { balance: 50 });
          throw new Error('Simulated mid-transaction failure');
        })
      ).rejects.toThrow('Simulated mid-transaction failure');

      const afterRollback = (await memory.get('account')) as { balance: number };
      expect(afterRollback.balance).toBe(100);
    });

    it('handles concurrent atomic updates without lost writes', async () => {
      await memory.put('counter', { count: 0 });

      // Run 20 concurrent increments
      await Promise.all(
        Array.from({ length: 20 }).map(() =>
          memory.atomicUpdate<{ count: number }>('counter', (curr) => ({
            count: (curr?.count || 0) + 1,
          }))
        )
      );

      const finalCount = (await memory.get('counter')) as { count: number };
      expect(finalCount.count).toBe(20);
    });
  });

  describe('IndexedDBStorageAdapter', () => {
    let idb: IndexedDBStorageAdapter;

    beforeEach(() => {
      const testDbName = 'test_storage_db_' + Math.random().toString(36).substring(2, 9);
      idb = new IndexedDBStorageAdapter({
        dbName: testDbName,
        storeName: 'records',
        keyPath: 'id',
      });
    });

    it('persists and retrieves records from IndexedDB', async () => {
      await idb.put('item-1', { id: 'item-1', data: 'stored-in-idb' });

      const read = (await idb.get('item-1')) as { id: string; data: string };
      expect(read).not.toBeNull();
      expect(read.data).toBe('stored-in-idb');

      const all = await idb.getAll();
      expect(all.length).toBe(1);
    });

    it('executes atomicUpdate inside IDB readwrite transaction synchronously', async () => {
      await idb.put('user-1', { id: 'user-1', views: 5 });

      const updated = await idb.atomicUpdate<{ id: string; views: number }>('user-1', (curr) => ({
        id: 'user-1',
        views: (curr?.views || 0) + 1,
      }));

      expect(updated.views).toBe(6);

      const read = (await idb.get('user-1')) as { id: string; views: number };
      expect(read.views).toBe(6);
    });

    it('performs batch reads and writes', async () => {
      const items = [
        { id: 'b1', v: 10 },
        { id: 'b2', v: 20 },
        { id: 'b3', v: 30 },
      ];

      await idb.putBatch(items.map((i) => ({ key: i.id, value: i })));

      const batchGet = await idb.getBatch(['b1', 'b3', 'non-existent']);
      expect(batchGet.length).toBe(3);
      expect((batchGet[0] as any).v).toBe(10);
      expect((batchGet[1] as any).v).toBe(30);
      expect(batchGet[2]).toBeNull();

      await idb.deleteBatch(['b1', 'b2']);
      const all = await idb.getAll();
      expect(all.length).toBe(1);
    });
  });
});
