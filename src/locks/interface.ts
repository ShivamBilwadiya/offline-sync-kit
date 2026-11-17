export interface LockSession {
  readonly lockName: string;
  readonly ownerId: string;
  readonly abortSignal: AbortSignal;
}

export interface LockManager {
  withLock<T>(
    name: string,
    callback: (session: LockSession) => Promise<T>,
    timeoutMs?: number
  ): Promise<T>;
  destroy?(): Promise<void>;
}
