export interface NetworkDetector {
  isOnline(): boolean;
  subscribe(callback: (isOnline: boolean) => void): () => void;
  destroy?(): void;
}

export class BrowserNetworkDetector implements NetworkDetector {
  isOnline(): boolean {
    if (typeof navigator !== 'undefined' && 'onLine' in navigator) {
      return navigator.onLine;
    }
    return true; // Default to assuming online in non-browser runtimes
  }

  subscribe(callback: (isOnline: boolean) => void): () => void {
    if (typeof window === 'undefined') {
      return () => {};
    }

    const handleOnline = () => callback(true);
    const handleOffline = () => callback(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }
}
