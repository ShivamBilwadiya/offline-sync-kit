import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import { OfflineSyncProvider } from '../src/react/context.js';
import { useOfflineSync } from '../src/react/hooks.js';
import { createOfflineSync } from '../src/client.js';

describe('F. React Bindings', () => {
  it('initializes provider and exposes state through useOfflineSync hook', async () => {
    const mockOnSync = vi.fn().mockResolvedValue({ success: true, results: [] });

    const client = createOfflineSync({
      storage: { type: 'memory' },
      onSync: mockOnSync,
    });

    function TestComponent() {
      const { isOnline, pendingCount, isSyncing } = useOfflineSync();
      return (
        <div>
          <span data-testid="online">{isOnline ? 'online' : 'offline'}</span>
          <span data-testid="pending">{pendingCount}</span>
          <span data-testid="syncing">{isSyncing ? 'syncing' : 'idle'}</span>
        </div>
      );
    }

    let getByTestId: any;
    await act(async () => {
      const rendered = render(
        <OfflineSyncProvider client={client}>
          <TestComponent />
        </OfflineSyncProvider>
      );
      getByTestId = rendered.getByTestId;
    });

    expect(getByTestId('online').textContent).toBe('online');
    expect(getByTestId('pending').textContent).toBe('0');
    expect(getByTestId('syncing').textContent).toBe('idle');

    await client.destroy();
  });

  it('updates pending count reactively when enqueue is called', async () => {
    const client = createOfflineSync({
      storage: { type: 'memory' },
      onSync: vi.fn().mockResolvedValue({ success: true, results: [] }),
    });

    let enqueueFn: any;

    function TestComponent() {
      const { pendingCount, enqueue } = useOfflineSync();
      enqueueFn = enqueue;
      return <span data-testid="pending">{pendingCount}</span>;
    }

    let getByTestId: any;
    await act(async () => {
      const rendered = render(
        <OfflineSyncProvider client={client}>
          <TestComponent />
        </OfflineSyncProvider>
      );
      getByTestId = rendered.getByTestId;
    });

    expect(getByTestId('pending').textContent).toBe('0');

    await act(async () => {
      await enqueueFn('TEST_REACT_ACTION', { foo: 'bar' });
    });

    await waitFor(() => {
      expect(getByTestId('pending').textContent).toBe('1');
    });

    await client.destroy();
  });

  it('cleans up event listeners when component unmounts', async () => {
    const client = createOfflineSync({
      storage: { type: 'memory' },
      onSync: vi.fn().mockResolvedValue({ success: true, results: [] }),
    });

    function Dummy() {
      useOfflineSync();
      return <div>Active</div>;
    }

    const { unmount } = render(
      <OfflineSyncProvider client={client}>
        <Dummy />
      </OfflineSyncProvider>
    );

    unmount();

    // Triggering events after unmount should not cause errors
    await act(async () => {
      await client.enqueue('POST_UNMOUNT_ACTION', {});
    });

    await client.destroy();
  });
});
