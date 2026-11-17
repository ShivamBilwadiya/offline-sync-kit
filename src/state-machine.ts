import type { SyncOperationStatus } from './types/index.js';
import { IllegalStateTransitionError } from './errors.js';

/**
 * Valid state transition graph.
 */
const ALLOWED_TRANSITIONS: Record<SyncOperationStatus, ReadonlySet<SyncOperationStatus>> = {
  PENDING: new Set<SyncOperationStatus>(['SYNCING']),
  SYNCING: new Set<SyncOperationStatus>([
    'SYNCED',
    'FAILED',
    'CONFLICT',
    'AUTH_BLOCKED',
    'PENDING', // Lease expiry or crash recovery
  ]),
  AUTH_BLOCKED: new Set<SyncOperationStatus>([
    'PENDING', // Re-authenticated
  ]),
  CONFLICT: new Set<SyncOperationStatus>([
    'PENDING', // Re-queued via custom resolver
    'SYNCED',  // Marked resolved
    'FAILED',  // Discarded
  ]),
  FAILED: new Set<SyncOperationStatus>([
    'PENDING', // Manual user retry
  ]),
  SYNCED: new Set<SyncOperationStatus>([]), // Terminal immutable state
};

export function canTransition(current: SyncOperationStatus, target: SyncOperationStatus): boolean {
  if (current === target) return true;
  const allowed = ALLOWED_TRANSITIONS[current];
  return allowed ? allowed.has(target) : false;
}

export function assertValidTransition(
  current: SyncOperationStatus,
  target: SyncOperationStatus,
  operationId?: string | number
): void {
  if (!canTransition(current, target)) {
    throw new IllegalStateTransitionError(current, target, operationId);
  }
}
