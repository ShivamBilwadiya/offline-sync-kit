import type { SyncOperationStatus } from './types/index.js';

export class SyncKitError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'SyncKitError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class IllegalStateTransitionError extends SyncKitError {
  constructor(
    public readonly currentStatus: SyncOperationStatus,
    public readonly targetStatus: SyncOperationStatus,
    public readonly operationId?: string | number
  ) {
    super(
      `Illegal operation state transition from '${currentStatus}' to '${targetStatus}'${
        operationId !== undefined ? ` for operation ${operationId}` : ''
      }.`,
      'ILLEGAL_STATE_TRANSITION'
    );
    this.name = 'IllegalStateTransitionError';
  }
}

export class LockLostError extends SyncKitError {
  constructor(public readonly lockName: string, reason: string = 'Lock lease expired or was preempted.') {
    super(`Lock '${lockName}' was lost: ${reason}`, 'LOCK_LOST');
    this.name = 'LockLostError';
  }
}

export class StorageError extends SyncKitError {
  constructor(message: string, public readonly originalError?: unknown) {
    super(message, 'STORAGE_ERROR');
    this.name = 'StorageError';
  }
}

export class StaleOperationError extends SyncKitError {
  constructor(public readonly operationId: string | number) {
    super(`Operation ${operationId} lease has expired or is invalid.`, 'STALE_OPERATION');
    this.name = 'StaleOperationError';
  }
}
