import type { SyncEventMap, SyncEventHandler } from '../types/index.js';

export class TypedEventEmitter {
  private listeners = new Map<keyof SyncEventMap, Set<SyncEventHandler<any>>>();

  on<K extends keyof SyncEventMap>(event: K, handler: SyncEventHandler<SyncEventMap[K]>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler as SyncEventHandler<any>);

    // Return cleanup unsubscribe function
    return () => {
      const current = this.listeners.get(event);
      if (current) {
        current.delete(handler as SyncEventHandler<any>);
        if (current.size === 0) {
          this.listeners.delete(event);
        }
      }
    };
  }

  emit<K extends keyof SyncEventMap>(event: K, data: SyncEventMap[K]): void {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) return;

    // Iterate over a snapshot in case listeners unsubscribe during emit
    for (const handler of Array.from(set)) {
      try {
        handler(data);
      } catch (err) {
        console.error(`Error in event listener for '${String(event)}':`, err);
      }
    }
  }

  removeAllListeners(): void {
    this.listeners.clear();
  }
}
