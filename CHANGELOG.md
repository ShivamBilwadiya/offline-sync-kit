# Changelog

All notable changes to `offline-sync-kit` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-11-17

### Added
- Core headless mutation queue with deterministic state machine (`PENDING`, `SYNCING`, `SYNCED`, `FAILED`, `CONFLICT`, `AUTH_BLOCKED`).
- Transactional `IndexedDBStorageAdapter` and `MemoryStorageAdapter`.
- Dual concurrency locking via Web Locks API (`navigator.locks`) with atomic dedicated IndexedDB fallback.
- Stale execution lease crash recovery preserving immutable `idempotencyKey` identifiers.
- Itemized partial batch synchronization contract (`SUCCESS`, `DUPLICATE_IDEMPOTENT`, `RETRYABLE_ERROR`, `PERMANENT_ERROR`, `CONFLICT`).
- Exponential backoff with jitter and configurable retry thresholds.
- Granular error classification (401 session expiration, 403 forbidden, 408 timeout, 429 rate limiting with Retry-After, 5xx server errors).
- Conflict isolation preserving original data divergence details without silent overwrites.
- Optional React integration (`offline-sync-kit/react`) providing `OfflineSyncProvider`, `useOfflineSync`, and `useSyncQueue`.
- Legacy compatibility mapping adapter interface for pre-existing legacy databases with collision protection against reserved queue metadata.
