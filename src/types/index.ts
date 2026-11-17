export type StorageKey = string | number;

/**
 * Universal Operation Sync States.
 * Single, unified state type across the entire package.
 */
export type SyncOperationStatus =
  | 'PENDING'       // Queued, waiting for dispatch
  | 'SYNCING'       // In-flight under active sync lease
  | 'SYNCED'        // Confirmed processed by server
  | 'FAILED'        // Permanently failed or exhausted retry budget
  | 'CONFLICT'      // Server/client conflict detected; isolated for resolution
  | 'AUTH_BLOCKED'; // Halted due to 401 Unauthorized; waiting for session renewal

export interface OperationMetadata {
  readonly id: StorageKey;             // Local queue key
  readonly idempotencyKey: string;     // Server deduplication UUID (never mutated)
  readonly type: string;               // Operation type identifier
  readonly createdAt: string;          // ISO 8601 original record creation timestamp
  status: SyncOperationStatus;
  retryCount: number;
  maxRetries: number;
  syncStartedAt?: string;              // ISO 8601 timestamp when current sync lease began
  leaseExpiresAt?: string;             // ISO 8601 timestamp when active lease expires
  lastError?: string;
  lastErrorCode?: string;
  conflictData?: unknown;
  /** Preserved unknown fields from legacy records to guarantee non-destructive reading */
  unrecognizedFields?: Record<string, unknown>;
}

export interface SyncOperation<TPayload = unknown> {
  metadata: OperationMetadata;
  payload: TPayload;
}

export interface EnqueueOptions {
  id?: StorageKey;
  idempotencyKey?: string;
  maxRetries?: number;
  createdAt?: string;
}

export type ErrorCategory =
  | 'AUTH_EXPIRED'        // HTTP 401: Whole session expired; pause queue
  | 'PERMISSION_DENIED'   // HTTP 403: Role/permission issue; fail this operation, DO NOT pause session
  | 'CLIENT_VALIDATION'   // HTTP 400, 422: Schema error; permanent failure
  | 'RATE_LIMITED'        // HTTP 429: Respect Retry-After
  | 'TIMEOUT'             // HTTP 408: Retryable
  | 'SERVER_ERROR'        // HTTP 5xx: Server transient failure
  | 'NETWORK_OFFLINE'     // Fetch error / disconnected
  | 'BUSINESS_CONFLICT'   // HTTP 409 or partial batch conflict flag
  | 'UNKNOWN';

export interface ClassifiedError {
  category: ErrorCategory;
  retryable: boolean;
  retryAfterSeconds?: number;
  message: string;
  originalError?: unknown;
}

export type ServerItemStatus =
  | 'SUCCESS'               // Successfully committed to database
  | 'DUPLICATE_IDEMPOTENT'  // Previously committed; safe to mark SYNCED
  | 'RETRYABLE_ERROR'       // Ephemeral failure (deadlock, transient DB timeout)
  | 'PERMANENT_ERROR'       // Validation/permission failure
  | 'CONFLICT';             // Data divergence

export interface ServerBatchItemResult {
  idempotencyKey: string;
  status: ServerItemStatus;
  error?: string;
  errorCode?: string;
  conflictDetails?: {
    serverTimestamp?: string;
    serverRecord?: unknown;
    reason?: string;
    [key: string]: unknown;
  };
}

export interface ServerBatchResponse {
  success: boolean;
  results: ServerBatchItemResult[];
}

export interface ConflictContext<TPayload = unknown> {
  operation: SyncOperation<TPayload>;
  conflictDetails?: unknown;
}

export type ConflictResolution<TPayload = unknown> =
  | { action: 'KEEP_CLIENT'; modifiedPayload?: TPayload }
  | { action: 'ACCEPT_SERVER' }
  | { action: 'MARK_RESOLVED'; resolutionNotes?: string }
  | { action: 'MANUAL_DEFER' };

export type ConflictResolver<TPayload = unknown> = (
  context: ConflictContext<TPayload>
) => Promise<ConflictResolution<TPayload>> | ConflictResolution<TPayload>;

export interface RetryPolicy {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffFactor: number;
  jitter: boolean;
  retryableHttpStatuses?: number[];
}

export interface LeaseConfig {
  leaseDurationMs: number;
}

export interface SyncSummary {
  totalProcessed: number;
  syncedCount: number;
  duplicatesCount: number;
  conflictsCount: number;
  failedCount: number;
  retryableCount: number;
  authBlocked: boolean;
  networkOffline?: boolean;
  retryAfterSeconds?: number;
}

export type SyncEventHandler<T = unknown> = (data: T) => void;

export interface SyncProgressData {
  current: number;
  total: number;
  operation?: SyncOperation;
}

export interface SyncEventMap {
  'sync:start': { count: number };
  'sync:progress': SyncProgressData;
  'sync:success': SyncSummary;
  'sync:error': { error: Error; summary?: SyncSummary };
  'queue:change': { pendingCount: number; failedCount: number; conflictCount: number };
  'operation:enqueued': { operation: SyncOperation };
  'operation:synced': { operation: SyncOperation; isDuplicate: boolean };
  'operation:failed': { operation: SyncOperation; error?: string };
  'operation:conflict': { operation: SyncOperation; conflictDetails?: unknown };
  'operation:recovered': { operation: SyncOperation; previousLeaseExpiresAt?: string };
  'auth:expired': { error: ClassifiedError };
  'auth:resumed': void;
  'network:change': { isOnline: boolean };
  'lock:acquired': { lockName: string; ownerId: string };
  'lock:lost': { lockName: string; reason: string };
}
