import { describe, it, expect, beforeEach } from 'vitest';
import { createOfflineSync } from '../src/client.js';
import type { RecordMappingAdapter, SyncOperation, StorageKey, SyncOperationStatus } from '../src/types/index.js';
import { IndexedDBStorageAdapter } from '../src/storage/indexeddb.js';

interface LegacyRecord {
  eventId: string;
  operationId: string;
  classId?: string;
  studentId?: string;
  sessionId?: string;
  qrToken?: string;
  status: string;
  synced: boolean;
  timestamp: string;
  retryCount: number;
  lastError: string | null;
  remarks?: string;
  conflictData?: unknown;
  syncStartedAt?: string | null;
  leaseExpiresAt?: string | null;
  [key: string]: unknown;
}

const RESERVED_KEYS = new Set([
  'eventId',
  'operationId',
  'status',
  'synced',
  'timestamp',
  'retryCount',
  'lastError',
  'conflictData',
  'syncStartedAt',
  'leaseExpiresAt',
]);

const sampleLegacyAdapter: RecordMappingAdapter<LegacyRecord> = {
  keyPath: 'eventId',

  getKey(op: SyncOperation): StorageKey {
    return String(op.metadata.id);
  },

  toStorage(op: SyncOperation): LegacyRecord {
    const rawPayload: Record<string, unknown> =
      typeof op.payload === 'object' && op.payload !== null
        ? { ...(op.payload as Record<string, unknown>) }
        : { data: op.payload };

    for (const key of RESERVED_KEYS) {
      delete rawPayload[key];
    }

    const preserved = op.metadata.unrecognizedFields ?? {};

    return {
      ...preserved,
      ...rawPayload,
      eventId: String(op.metadata.id),
      operationId: op.metadata.idempotencyKey,
      status: op.metadata.status,
      synced: op.metadata.status === 'SYNCED',
      timestamp: op.metadata.createdAt,
      retryCount: op.metadata.retryCount,
      lastError: op.metadata.lastError ?? null,
      conflictData: op.metadata.conflictData ?? null,
      syncStartedAt: op.metadata.syncStartedAt ?? null,
      leaseExpiresAt: op.metadata.leaseExpiresAt ?? null,
    };
  },

  fromStorage(record: LegacyRecord): SyncOperation {
    const eventId = String(record.eventId);
    const operationId = String(record.operationId || eventId);
    const createdAt = String(record.timestamp || new Date().toISOString());
    const rawStatus = String(record.status || 'PENDING') as SyncOperationStatus;
    const synced = Boolean(record.synced);
    const retryCount = Number(record.retryCount) || 0;
    const lastError = record.lastError ? String(record.lastError) : undefined;
    const conflictData = record.conflictData ?? undefined;
    const syncStartedAt = record.syncStartedAt ? String(record.syncStartedAt) : undefined;
    const leaseExpiresAt = record.leaseExpiresAt ? String(record.leaseExpiresAt) : undefined;

    const payload: Record<string, unknown> = {};
    const unrecognizedFields: Record<string, unknown> = {};

    for (const [key, val] of Object.entries(record)) {
      if (!RESERVED_KEYS.has(key)) {
        payload[key] = val;
      }
    }

    const status: SyncOperationStatus =
      synced && rawStatus !== 'SYNCED' ? 'SYNCED' : rawStatus;

    return {
      metadata: {
        id: eventId,
        idempotencyKey: operationId,
        type: String(record.type || 'SHIKSHA_LEGACY_ATTENDANCE'),
        createdAt,
        status,
        retryCount,
        maxRetries: 5,
        lastError,
        conflictData,
        syncStartedAt,
        leaseExpiresAt,
        unrecognizedFields,
      },
      payload,
    };
  },
};


describe('E. ShikshaTrack Legacy Compatibility', () => {
  const DB_NAME = 'ShikshaTrackOfflineDB';
  const DB_VERSION = 2;

  beforeEach(async () => {
    // Setup exact ShikshaTrack v2 database structure
    await new Promise<void>((resolve, reject) => {
      const delReq = indexedDB.deleteDatabase(DB_NAME);
      delReq.onsuccess = () => resolve();
      delReq.onerror = () => reject(delReq.error);
    });

    await new Promise<void>((resolve, reject) => {
      const openReq = indexedDB.open(DB_NAME, DB_VERSION);
      openReq.onupgradeneeded = (event) => {
        const db = openReq.result;

        // Store 1: Class rosters
        if (!db.objectStoreNames.contains('rosters')) {
          db.createObjectStore('rosters', { keyPath: 'classId' });
        }

        // Store 2: Offline attendance syncQueue with existing indexes
        if (!db.objectStoreNames.contains('syncQueue')) {
          const queueStore = db.createObjectStore('syncQueue', { keyPath: 'eventId' });
          queueStore.createIndex('synced', 'synced', { unique: false });
          queueStore.createIndex('status', 'status', { unique: false });
          queueStore.createIndex('classId', 'classId', { unique: false });
        }

        // Store 3: General offline key-value cache
        if (!db.objectStoreNames.contains('offlineCache')) {
          db.createObjectStore('offlineCache', { keyPath: 'key' });
        }

        // Store 4: Conflict store
        if (!db.objectStoreNames.contains('conflicts')) {
          db.createObjectStore('conflicts', { keyPath: 'id' });
        }
      };

      openReq.onsuccess = () => {
        const db = openReq.result;
        // Pre-populate legacy roster data in 'rosters'
        const tx = db.transaction(['rosters', 'syncQueue'], 'readwrite');
        const rosterStore = tx.objectStore('rosters');
        rosterStore.put({
          classId: 'class-8a-default',
          className: 'Class 8-A',
          students: [{ id: 'st-1', name: 'Aarav Sharma' }],
        });

        // Pre-populate legacy pending records in 'syncQueue'
        const queueStore = tx.objectStore('syncQueue');
        queueStore.put({
          eventId: 'offline-legacy-12345',
          operationId: 'op-legacy-999',
          classId: 'class-8a-default',
          studentId: 'st-1',
          qrToken: 'QR_TOKEN_ABC',
          status: 'PENDING',
          synced: false,
          timestamp: '2026-11-15T10:00:00.000Z',
          retryCount: 0,
          lastError: null,
          remarks: 'Present during morning session',
        });

        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      openReq.onerror = () => reject(openReq.error);
    });
  });

  it('reads existing pending records and preserves eventId and operationId without version upgrade', async () => {
    let upgradeTriggered = false;

    const storage = new IndexedDBStorageAdapter({
      dbName: DB_NAME,
      storeName: 'syncQueue',
      version: DB_VERSION, // Strict version 2 preserved
      keyPath: 'eventId',
    });

    const client = createOfflineSync({
      storage: {
        customAdapter: storage,
        mapping: sampleLegacyAdapter,
      },
      onSync: async () => ({ success: true, results: [] }),
    });

    const pending = await client.getPending();
    expect(pending.length).toBe(1);

    const legacyOp = pending[0]!;
    expect(legacyOp.metadata.id).toBe('offline-legacy-12345');
    expect(legacyOp.metadata.idempotencyKey).toBe('op-legacy-999');
    expect(legacyOp.metadata.status).toBe('PENDING');

    // Application payload extracted cleanly
    const payload = legacyOp.payload as any;
    expect(payload.studentId).toBe('st-1');
    expect(payload.classId).toBe('class-8a-default');
    expect(payload.qrToken).toBe('QR_TOKEN_ABC');
    expect(payload.remarks).toBe('Present during morning session');

    await client.destroy();
  });

  it('leaves unrelated stores (rosters, offlineCache, conflicts) completely untouched', async () => {
    const storage = new IndexedDBStorageAdapter({
      dbName: DB_NAME,
      storeName: 'syncQueue',
      version: DB_VERSION,
      keyPath: 'eventId',
    });

    const client = createOfflineSync({
      storage: {
        customAdapter: storage,
        mapping: sampleLegacyAdapter,
      },
      onSync: async (batch) => {
        return {
          success: true,
          results: batch.map((op) => ({
            idempotencyKey: op.metadata.idempotencyKey,
            status: 'SUCCESS' as const,
          })),
        };
      },
    });

    // Enqueue new event and sync
    await client.enqueue('ATTENDANCE_SCAN', {
      studentId: 'st-2',
      classId: 'class-8a-default',
    });

    await client.syncNow();

    // Verify 'rosters' store is completely intact
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    const tx = db.transaction('rosters', 'readonly');
    const rosterStore = tx.objectStore('rosters');
    const roster = await new Promise<any>((resolve) => {
      const getReq = rosterStore.get('class-8a-default');
      getReq.onsuccess = () => resolve(getReq.result);
    });

    expect(roster).not.toBeNull();
    expect(roster.className).toBe('Class 8-A');
    expect(roster.students[0].name).toBe('Aarav Sharma');

    db.close();
    await client.destroy();
  });

  it('protects reserved metadata from payload collision', async () => {
    const storage = new IndexedDBStorageAdapter({
      dbName: DB_NAME,
      storeName: 'syncQueue',
      version: DB_VERSION,
      keyPath: 'eventId',
    });

    const client = createOfflineSync({
      storage: {
        customAdapter: storage,
        mapping: sampleLegacyAdapter,
      },
      onSync: async () => ({ success: true, results: [] }),
    });

    // Attempt to inject reserved keys in application payload
    const op = await client.enqueue('MALICIOUS_OVERWRITE', {
      eventId: 'fake-event-id',
      status: 'SYNCED',
      synced: true,
      retryCount: 999,
      studentId: 'valid-student',
    });

    // The true queue metadata must NOT be overwritten!
    expect(op.metadata.id).not.toBe('fake-event-id');
    expect(op.metadata.status).toBe('PENDING');
    expect(op.metadata.retryCount).toBe(0);

    const stored = (await storage.get(op.metadata.id)) as any;
    expect(stored.eventId).toBe(op.metadata.id);
    expect(stored.status).toBe('PENDING');
    expect(stored.synced).toBe(false);
    expect(stored.retryCount).toBe(0);
    expect(stored.studentId).toBe('valid-student');

    await client.destroy();
  });

  it('preserves existing indexes and allows query by index', async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    const tx = db.transaction('syncQueue', 'readonly');
    const store = tx.objectStore('syncQueue');

    expect(store.indexNames.contains('synced')).toBe(true);
    expect(store.indexNames.contains('status')).toBe(true);
    expect(store.indexNames.contains('classId')).toBe(true);

    const statusIndex = store.index('status');
    const pendingItems = await new Promise<any[]>((resolve) => {
      const req = statusIndex.getAll('PENDING');
      req.onsuccess = () => resolve(req.result);
    });

    expect(pendingItems.length).toBeGreaterThanOrEqual(1);
    expect(pendingItems[0].eventId).toBe('offline-legacy-12345');

    db.close();
  });
});
