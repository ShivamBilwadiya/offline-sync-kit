import { createContext, useContext, useState, useEffect, useMemo } from 'react';
import type { ReactNode } from 'react';
import { OfflineSyncClient, OfflineSyncConfig } from '../client.js';

export interface OfflineSyncContextValue<TPayload = unknown> {
  client: OfflineSyncClient<TPayload>;
  isOnline: boolean;
  isSyncing: boolean;
  pendingCount: number;
  failedCount: number;
  conflictCount: number;
  syncNow: () => Promise<unknown>;
  retryFailed: () => Promise<unknown>;
  resumeSync: () => Promise<number>;
}

export const OfflineSyncReactContext = createContext<OfflineSyncContextValue<any> | null>(null);

export interface OfflineSyncProviderProps<TPayload = unknown> {
  client?: OfflineSyncClient<TPayload>;
  config?: OfflineSyncConfig<TPayload>;
  children: ReactNode;
}

export function OfflineSyncProvider<TPayload = unknown>({
  client: externalClient,
  config,
  children,
}: OfflineSyncProviderProps<TPayload>) {
  const client = useMemo(() => {
    if (externalClient) return externalClient;
    if (!config) {
      throw new Error('OfflineSyncProvider requires either a `client` or `config` prop.');
    }
    return new OfflineSyncClient<TPayload>(config);
  }, [externalClient, config]);

  const [isOnline, setIsOnline] = useState<boolean>(() => client.isOnline());
  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const [counts, setCounts] = useState({ pendingCount: 0, failedCount: 0, conflictCount: 0 });

  useEffect(() => {
    let mounted = true;

    if (client.isDestroyed()) {
      return;
    }

    client.retain();

    // Load initial counts
    client.getCounts().then((c) => {
      if (mounted) setCounts(c);
    });

    const unsubStart = client.on('sync:start', () => {
      if (mounted) setIsSyncing(true);
    });

    const unsubSuccess = client.on('sync:success', () => {
      if (mounted) setIsSyncing(false);
    });

    const unsubError = client.on('sync:error', () => {
      if (mounted) setIsSyncing(false);
    });

    const unsubQueue = client.on('queue:change', (newCounts) => {
      if (mounted) setCounts(newCounts);
    });

    const unsubNetwork = client.on('network:change', ({ isOnline: online }) => {
      if (mounted) setIsOnline(online);
    });

    return () => {
      mounted = false;
      unsubStart();
      unsubSuccess();
      unsubError();
      unsubQueue();
      unsubNetwork();

      // Defer destruction via lease counting so React StrictMode double-mount is safe
      if (!externalClient) {
        client.release();
      }
    };
  }, [client, externalClient]);

  const value: OfflineSyncContextValue<TPayload> = {
    client,
    isOnline,
    isSyncing,
    pendingCount: counts.pendingCount,
    failedCount: counts.failedCount,
    conflictCount: counts.conflictCount,
    syncNow: () => client.syncNow(),
    retryFailed: () => client.retryFailed(),
    resumeSync: () => client.resumeSync(),
  };

  return (
    <OfflineSyncReactContext.Provider value={value}>
      {children}
    </OfflineSyncReactContext.Provider>
  );
}

export function useOfflineSyncContext<TPayload = unknown>(): OfflineSyncContextValue<TPayload> {
  const ctx = useContext(OfflineSyncReactContext);
  if (!ctx) {
    throw new Error('useOfflineSyncContext must be used within an <OfflineSyncProvider>');
  }
  return ctx;
}
