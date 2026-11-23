/// <reference types="vite/client" />

import { MonitorSnapshot } from './types/monitor';

declare global {
  interface Window {
    herdrIsland?: {
      getSnapshot: () => Promise<MonitorSnapshot>;
      onSnapshot: (callback: (snapshot: MonitorSnapshot) => void) => () => void;
      setInteractive: (interactive: boolean) => void;
      startDrag: () => void;
      moveDrag: () => void;
      endDrag: () => void;
      resetPosition: () => void;
      toggleDemoMode: () => Promise<MonitorSnapshot>;
      togglePin: () => Promise<MonitorSnapshot>;
      refreshNow: () => Promise<MonitorSnapshot>;
    };
  }
}

export {};
