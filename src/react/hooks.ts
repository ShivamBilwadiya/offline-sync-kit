import { useState, useEffect, useCallback } from 'react';
import type { SyncOperation, EnqueueOptions } from '../types/index.js';
import { useOfflineSyncContext } from './context.js';

export function useOfflineSync<TPayload = unknown>() {
  const context = useOfflineSyncContext<TPayload>();

  const enqueue = useCallback(
    (type: string, payload: TPayload, options?: EnqueueOptions) => {
      return context.client.enqueue(type, payload, options);
    },
    [context.client]
  );

  return {
    ...context,
    enqueue,
  };
}

export function useSyncQueue<TPayload = unknown>() {
  const { client } = useOfflineSyncContext<TPayload>();
  const [operations, setOperations] = useState<Array<SyncOperation<TPayload>>>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const ops = await client.getAll();
      setOperations(ops);
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    let mounted = true;
    refresh();

    const unsubQueue = client.on('queue:change', () => {
      if (mounted) refresh();
    });

    return () => {
      mounted = false;
      unsubQueue();
    };
  }, [client, refresh]);

  return {
    operations,
    refresh,
    loading,
  };
}
