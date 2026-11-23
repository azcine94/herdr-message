import { contextBridge, ipcRenderer } from 'electron';
import { MonitorSnapshot } from '../src/types/monitor';

export interface HerdrIslandApi {
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
}

const api: HerdrIslandApi = {
  getSnapshot: () => ipcRenderer.invoke('island:get-snapshot'),
  onSnapshot: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: MonitorSnapshot) => {
      callback(snapshot);
    };
    ipcRenderer.on('island:snapshot', handler);
    return () => {
      ipcRenderer.removeListener('island:snapshot', handler);
    };
  },
  setInteractive: (interactive: boolean) => {
    ipcRenderer.send('island:set-interactive', interactive);
  },
  startDrag: () => {
    ipcRenderer.send('island:drag-start');
  },
  moveDrag: () => {
    ipcRenderer.send('island:drag-move');
  },
  endDrag: () => {
    ipcRenderer.send('island:drag-end');
  },
  resetPosition: () => {
    ipcRenderer.send('island:reset-position');
  },
  toggleDemoMode: () => ipcRenderer.invoke('island:toggle-demo'),
  togglePin: () => ipcRenderer.invoke('island:toggle-pin'),
  refreshNow: () => ipcRenderer.invoke('island:refresh'),
};

contextBridge.exposeInMainWorld('herdrIsland', api);
