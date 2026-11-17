# offline-sync-kit

> A resilient, framework-agnostic, offline-first synchronization and mutation queue kit for modern web and React applications.

[![npm version](https://img.shields.io/badge/npm-0.1.0-blue.svg)](https://www.npmjs.com/package/offline-sync-kit)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict-blue.svg)](https://www.typescriptlang.org/)

---

## 🚀 Features

- **🔌 Zero Core Dependencies**: The core synchronization engine is 100% headless and framework-agnostic.
- **💾 Pluggable Storage**: Built-in transactional **IndexedDB** for browsers and **MemoryStorage** for Node.js/testing.
- **🔒 Multi-Tab Concurrency**: Process-level synchronization locking using the **Web Locks API** with an atomic dedicated IndexedDB fallback.
- **🛡️ Idempotent by Design**: Strict client-side `idempotencyKey` lifecycle protects against duplicate server commits across retries.
- **🔄 Crash Recovery**: Recovers operations interrupted by tab crashes or power loss by detecting stale execution leases.
- **🚦 Granular Error Classification**: Differentiates between auth expiration (`401`), permission rejection (`403`), timeouts (`408`), rate limits (`429`), server transients (`5xx`), and client schema errors (`400`/`422`).
- **🤝 Safe Conflict Isolation**: Isolates conflicting mutations without silent client-wins or server-wins overwrites, with optional custom arbitration hooks.
- **⚛️ Optional React Bindings**: First-class `<OfflineSyncProvider />`, `useOfflineSync()`, and `useSyncQueue()` hooks with zero bloat for vanilla JS users.
- **🏛️ Non-Destructive Legacy Compatibility**: Pluggable `RecordMappingAdapter` allows connecting to existing legacy IndexedDB databases without schema version bumps or data loss.

---

## 📦 Installation

```bash
# Core package
npm install offline-sync-kit

# Or with yarn / pnpm
pnpm add offline-sync-kit
```

*Note: `react` (>=16.8.0) is an optional peer dependency. If you only use vanilla JavaScript or TypeScript, React is not required.*

---

## 📖 Quickstart

### 1. Vanilla JavaScript / TypeScript

```typescript
import { createOfflineSync } from 'offline-sync-kit';

// 1. Create client
const sync = createOfflineSync({
  storage: {
    dbName: 'my_app_db',
    storeName: 'offline_queue',
  },
  batchSize: 20,
  retry: {
    maxRetries: 5,
    initialDelayMs: 1000,
  },
  // 2. Define server dispatch handler
  onSync: async (batch, abortSignal) => {
    const res = await fetch('/api/v1/sync/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operations: batch.map((op) => ({
          idempotencyKey: op.metadata.idempotencyKey,
          type: op.metadata.type,
          payload: op.payload,
        })),
      }),
      signal: abortSignal,
    });

    const data = await res.json();
    return {
      success: res.ok,
      results: data.results, // Array of { idempotencyKey, status: 'SUCCESS' | 'RETRYABLE_ERROR' | ... }
    };
  },
});

// 3. Enqueue operations while offline
await sync.enqueue('CREATE_NOTE', {
  title: 'Field observation',
  content: 'Recorded without connectivity',
});

// 4. Listen to events
sync.on('sync:start', ({ count }) => console.log(`Syncing ${count} operations...`));
sync.on('sync:success', (summary) => console.log('Sync complete:', summary));
sync.on('network:change', ({ isOnline }) => console.log('Online status:', isOnline));
```

---

### 2. React Integration

Import from the dedicated `./react` entrypoint:

```tsx
import React from 'react';
import { OfflineSyncProvider, useOfflineSync } from 'offline-sync-kit/react';

// A. Wrap application
export function App() {
  return (
    <OfflineSyncProvider
      config={{
        storage: { dbName: 'my_app_offline' },
        onSync: async (batch) => {
          const res = await myApi.post('/sync', { batch });
          return res.data;
        },
      }}
    >
      <AttendanceView />
    </OfflineSyncProvider>
  );
}

// B. Consume inside components
function AttendanceView() {
  const { isOnline, isSyncing, pendingCount, enqueue, syncNow } = useOfflineSync();

  const handleScan = async (studentId: string) => {
    await enqueue('SCAN_ATTENDANCE', {
      studentId,
      scannedAt: new Date().toISOString(),
    });
  };

  return (
    <div>
      <div>Connection: {isOnline ? '🟢 Connected' : '🟠 Offline Mode'}</div>
      <div>Pending Sync: {pendingCount}</div>
      {isSyncing && <p>Uploading pending records...</p>}
      <button onClick={() => handleScan('ST-101')}>Mark Present</button>
      <button onClick={() => syncNow()} disabled={isSyncing || !isOnline}>
        Sync Now
      </button>
    </div>
  );
}
```

---

## 🛠️ Configuration Options

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `storage.type` | `'indexeddb' \| 'memory'` | `'indexeddb'` | Storage adapter to use. |
| `storage.dbName` | `string` | `'offline_sync_kit_db'` | Database name. |
| `storage.storeName` | `string` | `'operations'` | Object store name. |
| `storage.mapping` | `RecordMappingAdapter` | `defaultRecordMappingAdapter` | Custom record mapping adapter. |
| `batchSize` | `number` | `25` | Maximum operations per batch. |
| `retry.maxRetries` | `number` | `5` | Maximum automatic retries before moving to `FAILED`. |
| `retry.initialDelayMs`| `number` | `1000` | Initial exponential backoff delay. |
| `retry.maxDelayMs` | `number` | `30000` | Maximum cap on backoff delay. |
| `lease.leaseDurationMs`| `number` | `60000` | Execution lease duration before an in-flight operation is deemed stale. |
| `preferWebLocks` | `boolean` | `true` | Prefer Web Locks API with fallback to dedicated lock DB. |
| `cleanupStrategy` | `'keep' \| 'delete'` | `'keep'` | Whether to delete or preserve `SYNCED` records locally. |
| `conflictResolver` | `ConflictResolver` | `undefined` | Custom resolver for data conflicts. |

---

## 📋 Server Response Contract

The sync engine accommodates partial batch successes and failures. The server should respond with an itemized result list keyed by `idempotencyKey`:

```typescript
interface ServerBatchResponse {
  success: boolean;
  results: Array<{
    idempotencyKey: string;
    status:
      | 'SUCCESS'              // Successfully written
      | 'DUPLICATE_IDEMPOTENT' // Previously processed; safe to mark SYNCED
      | 'RETRYABLE_ERROR'      // Transient failure (lock timeout, 5xx)
      | 'PERMANENT_ERROR'      // Validation / permission failure
      | 'CONFLICT';            // Data divergence detected
    error?: string;
    conflictDetails?: unknown;
  }>;
}
```

---

## 🏛️ Legacy IndexedDB Compatibility & Custom Record Mapping

To connect `offline-sync-kit` to an existing legacy IndexedDB database without triggering `onupgradeneeded` or modifying other object stores, implement a custom `RecordMappingAdapter`:

```typescript
import { createOfflineSync, type RecordMappingAdapter } from 'offline-sync-kit';

// Define the shape of records in your existing database
interface MyLegacyRecord {
  eventId: string;
  operationId: string;
  status: string;
  synced: boolean;
  timestamp: string;
  [key: string]: unknown;
}

const myLegacyAdapter: RecordMappingAdapter<MyLegacyRecord> = {
  keyPath: 'eventId',
  getKey: (op) => String(op.metadata.id),
  toStorage: (op) => ({
    ...(op.payload as Record<string, unknown>),
    eventId: String(op.metadata.id),
    operationId: op.metadata.idempotencyKey,
    status: op.metadata.status,
    synced: op.metadata.status === 'SYNCED',
    timestamp: op.metadata.createdAt,
  }),
  fromStorage: (record) => ({
    metadata: {
      id: record.eventId,
      idempotencyKey: record.operationId,
      type: 'LEGACY_MUTATION',
      createdAt: record.timestamp,
      status: record.synced ? 'SYNCED' : (record.status as any),
      retryCount: 0,
      maxRetries: 5,
    },
    payload: record,
  }),
};

const client = createOfflineSync({
  storage: {
    dbName: 'MyLegacyOfflineDB',
    storeName: 'syncQueue',
    version: 2, // Keeps existing v2 schema intact without upgrade
    keyPath: 'eventId',
    mapping: myLegacyAdapter,
  },
  onSync: async (batch) => {
    // your transport logic
  },
});
```

---

## 📄 License

MIT © [Shivam Bilwadiya](https://github.com/ShivamBilwadiya)
