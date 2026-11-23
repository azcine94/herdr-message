import {
  app,
  BrowserWindow,
  Display,
  ipcMain,
  Menu,
  nativeImage,
  Point,
  screen,
  shell,
  Tray,
} from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MonitorSnapshot } from '../src/types/monitor';
import { buildDemoSnapshot } from './demoData';
import { HerdrMonitor } from './herdr/herdrMonitor';
import { QuotaManager } from './quota/quotaManager';

const CANVAS_WIDTH = 468;
const CANVAS_HEIGHT = 820;

interface SavedPosition {
  x: number;
  y: number;
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let herdrMonitor: HerdrMonitor | null = null;
let quotaManager: QuotaManager | null = null;
let quotaTimer: NodeJS.Timeout | null = null;

let demoMode = false;
let demoAnchorTime = Date.now();
let pinned = false;
let isQuitting = false;
let selectedDisplayId: number | null = null;
let savedCustomPosition: SavedPosition | null = null;
let lastQuotaAlertId: string | null = null;

function logRuntimeError(tag: string, err: unknown): void {
  try {
    const msg = err instanceof Error ? err.stack || err.message : String(err);
    const line = `[${new Date().toISOString()}] [${tag}] ${msg}\n`;
    const logPath = path.join(app.getPath('userData'), 'runtime.log');
    void fs.appendFile(logPath, line, 'utf8').catch(() => {});
  } catch {
    // ignore logging failure
  }
}

// Keep daemon alive permanently: never let transient unhandled async errors terminate Electron
process.on('uncaughtException', (err) => {
  logRuntimeError('uncaughtException', err);
});
process.on('unhandledRejection', (reason) => {
  logRuntimeError('unhandledRejection', reason);
});

// 120Hz Main-Process Direct Cursor Tracking State
let dragInterval: NodeJS.Timeout | null = null;
let dragStartCursor: Point | null = null;
let dragStartWinPos: [number, number] | null = null;
let lastAppliedPos: [number, number] | null = null;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

function positionStorePath(): string {
  return path.join(app.getPath('userData'), 'window-position.json');
}

async function loadSavedPosition(): Promise<void> {
  try {
    const raw = await fs.readFile(positionStorePath(), 'utf8');
    const parsed = JSON.parse(raw) as SavedPosition;
    if (
      parsed &&
      typeof parsed.x === 'number' &&
      typeof parsed.y === 'number' &&
      Number.isFinite(parsed.x) &&
      Number.isFinite(parsed.y)
    ) {
      const displays = screen.getAllDisplays();
      const centerX = parsed.x + CANVAS_WIDTH / 2;
      const topY = parsed.y + 24;
      const visible = displays.some(
        (d) =>
          centerX >= d.bounds.x &&
          centerX <= d.bounds.x + d.bounds.width &&
          topY >= d.bounds.y &&
          topY <= d.bounds.y + d.bounds.height,
      );
      if (visible) {
        savedCustomPosition = parsed;
      }
    }
  } catch {
    // ignore
  }
}

async function persistPosition(pos: SavedPosition | null): Promise<void> {
  try {
    if (!pos) {
      await fs.rm(positionStorePath(), { force: true });
      return;
    }
    await fs.writeFile(positionStorePath(), JSON.stringify(pos), 'utf8');
  } catch {
    // ignore
  }
}

function getTargetDisplay(): Display {
  const displays = screen.getAllDisplays();
  if (selectedDisplayId !== null) {
    const matched = displays.find((d) => d.id === selectedDisplayId);
    if (matched) return matched;
  }
  return screen.getPrimaryDisplay();
}

function getDefaultTopCenterPosition(): SavedPosition {
  const display = getTargetDisplay();
  const { x, y, width } = display.bounds;
  return {
    x: Math.round(x + (width - CANVAS_WIDTH) / 2),
    y: y + 2,
  };
}

function applyWindowPosition(win: BrowserWindow, pos?: SavedPosition): void {
  const target = pos ?? savedCustomPosition ?? getDefaultTopCenterPosition();
  win.setBounds({
    x: target.x,
    y: target.y,
    width: CANVAS_WIDTH,
    height: CANVAS_HEIGHT,
  });
}

function stopMainDrag(): void {
  if (dragInterval) {
    clearInterval(dragInterval);
    dragInterval = null;
  }
  if (mainWindow && !mainWindow.isDestroyed() && lastAppliedPos) {
    const [fx, fy] = lastAppliedPos;
    mainWindow.setBounds({
      x: fx,
      y: fy,
      width: CANVAS_WIDTH,
      height: CANVAS_HEIGHT,
    });
    savedCustomPosition = { x: fx, y: fy };
    void persistPosition(savedCustomPosition);
  }
  dragStartCursor = null;
  dragStartWinPos = null;
  lastAppliedPos = null;
}

function createTrayNativeImage(): Electron.NativeImage {
  const size = 32;
  const buf = Buffer.alloc(size * size * 4, 0);

  const setPixel = (px: number, py: number, r: number, g: number, b: number, a: number) => {
    if (px < 0 || px >= size || py < 0 || py >= size) return;
    const idx = (py * size + px) * 4;
    buf[idx] = b;
    buf[idx + 1] = g;
    buf[idx + 2] = r;
    buf[idx + 3] = a;
  };

  for (let y = 8; y <= 23; y++) {
    for (let x = 2; x <= 29; x++) {
      const cy = 15.5;
      const cx = x < 9 ? 9 : x > 22 ? 22 : x;
      const dist = Math.hypot(x - cx, y - cy);
      if (dist <= 7.6) {
        const edgeAlpha = dist > 6.6 ? Math.round((7.6 - dist) * 255) : 255;
        setPixel(x, y, 18, 20, 26, edgeAlpha);
      }
    }
  }

  for (let y = 11; y <= 20; y++) {
    for (let x = 6; x <= 15; x++) {
      const dist = Math.hypot(x - 10, y - 15.5);
      if (dist <= 3.3) {
        const alpha = dist > 2.4 ? Math.round((3.3 - dist) * 255) : 255;
        setPixel(x, y, 16, 185, 129, alpha);
      }
    }
  }

  for (let y = 14; y <= 17; y++) {
    for (let x = 16; x <= 24; x++) {
      setPixel(x, y, 240, 244, 248, 235);
    }
  }

  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function buildSnapshot(): MonitorSnapshot {
  if (demoMode) {
    const demo = buildDemoSnapshot(demoAnchorTime);
    return {
      connected: true,
      hcPath: herdrMonitor?.getState().hcPath,
      demoMode: true,
      pinned,
      tasks: demo.tasks,
      quotas: demo.quotas,
      latestAlert: demo.alert,
      updatedAt: Date.now(),
    };
  }

  const herdrState = herdrMonitor?.getState() ?? {
    connected: false,
    connectionHint: '正在初始化...',
    hcPath: undefined,
    tasks: [],
    latestAlert: null,
    screens: [],
  };

  const quotas = quotaManager?.getQuotas() ?? [];
  let alert = herdrState.latestAlert;

  const lowProvider = quotas.find((q) => q.lowQuota);
  if (lowProvider) {
    const lowId = `low-${lowProvider.id}-${lowProvider.primary?.remainingPct ?? 'credits'}`;
    if (lastQuotaAlertId !== lowId) {
      lastQuotaAlertId = lowId;
      alert = {
        id: lowId,
        kind: 'low_quota',
        brand: lowProvider.brand,
        brandLabel: lowProvider.name,
        title: `${lowProvider.name} 剩余额度偏低`,
        subtitle: lowProvider.primary
          ? `${lowProvider.primary.label} 仅剩 ${lowProvider.primary.remainingPct}%`
          : (lowProvider.badgeText ?? '请注意配额余量'),
        timestamp: Date.now(),
      };
    }
  }

  return {
    connected: herdrState.connected,
    connectionHint: herdrState.connectionHint,
    hcPath: herdrState.hcPath,
    demoMode: false,
    pinned,
    tasks: herdrState.tasks,
    quotas,
    latestAlert: alert,
    updatedAt: Date.now(),
  };
}

function broadcastSnapshot(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('island:snapshot', buildSnapshot());
}

async function refreshAll(forceProbes = false): Promise<void> {
  if (herdrMonitor) {
    await herdrMonitor.forceRefresh();
    const state = herdrMonitor.getState();
    if (quotaManager) {
      await quotaManager.collectAll(state.tasks, state.screens, {
        force: forceProbes,
        waitForProbes: forceProbes,
      });
    }
  }
  broadcastSnapshot();
}

function rebuildTrayMenu(): void {
  if (!tray) return;
  const displays = screen.getAllDisplays();
  const currentDisplay = getTargetDisplay();

  const displayItems: Electron.MenuItemConstructorOptions[] = displays.map((d, idx) => ({
    label: `显示器 ${idx + 1} (${d.bounds.width}×${d.bounds.height})${
      d.id === screen.getPrimaryDisplay().id ? ' · 主屏' : ''
    }`,
    type: 'radio',
    checked: d.id === currentDisplay.id,
    click: () => {
      selectedDisplayId = d.id;
      savedCustomPosition = null;
      void persistPosition(null);
      if (mainWindow) applyWindowPosition(mainWindow);
      rebuildTrayMenu();
    },
  }));

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Herdr Island · 只读监控', enabled: false },
    { type: 'separator' },
    {
      label: mainWindow?.isVisible() ? '隐藏灵动岛' : '显示灵动岛',
      click: () => {
        if (!mainWindow) return;
        if (mainWindow.isVisible()) mainWindow.hide();
        else {
          applyWindowPosition(mainWindow);
          mainWindow.showInactive();
        }
        rebuildTrayMenu();
      },
    },
    {
      label: '重置位置（回屏幕顶部居中）',
      click: () => {
        savedCustomPosition = null;
        void persistPosition(null);
        if (mainWindow) applyWindowPosition(mainWindow, getDefaultTopCenterPosition());
      },
    },
    {
      label: '固定展开面板 (Pin)',
      type: 'checkbox',
      checked: pinned,
      click: () => {
        pinned = !pinned;
        broadcastSnapshot();
        rebuildTrayMenu();
      },
    },
    {
      label: '预览演示数据 (Demo)',
      type: 'checkbox',
      checked: demoMode,
      click: () => {
        demoMode = !demoMode;
        if (demoMode) demoAnchorTime = Date.now();
        broadcastSnapshot();
        rebuildTrayMenu();
      },
    },
    { type: 'separator' },
    {
      label: '投放显示器',
      submenu: displayItems,
    },
    {
      label: '立即刷新状态与额度',
      click: () => {
        void refreshAll(true);
      },
    },
    {
      label: '打开自定义配额目录 (~/.herdr-island/quotas)',
      click: async () => {
        if (!quotaManager) return;
        const dir = quotaManager.getCustomQuotasDir();
        await fs.mkdir(dir, { recursive: true }).catch(() => {});
        await shell.openPath(dir);
      },
    },
    { type: 'separator' },
    {
      label: '退出 Herdr Island',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
}

async function createWindow(): Promise<void> {
  const initialPos = savedCustomPosition ?? getDefaultTopCenterPosition();

  const win = new BrowserWindow({
    x: initialPos.x,
    y: initialPos.y,
    width: CANVAS_WIDTH,
    height: CANVAS_HEIGHT,
    show: false,
    title: '',
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    type: 'toolbar',
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow = win;
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true, { forward: true });

  win.once('ready-to-show', () => {
    applyWindowPosition(win, initialPos);
    win.showInactive();
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    await win.loadURL(devUrl);
  } else {
    const indexHtml = path.resolve(__dirname, '..', '..', 'dist', 'index.html');
    await win.loadFile(indexHtml);
  }

  // Prevent accidental WM_CLOSE / Alt+F4 from closing the resident island unless explicitly quitting
  win.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
    }
  });

  // Auto-recover renderer if GPU/renderer resets (e.g. after sleep/wake or driver reset)
  win.webContents.on('render-process-gone', (_event, details) => {
    logRuntimeError('render-process-gone', details.reason);
    if (!isQuitting && !win.isDestroyed()) {
      setTimeout(() => {
        if (!win.isDestroyed()) {
          win.reload();
        }
      }, 800);
    }
  });

  win.on('closed', () => {
    stopMainDrag();
    mainWindow = null;
  });
}

app.on('second-instance', () => {
  if (mainWindow) {
    mainWindow.showInactive();
  }
});

app.whenReady().then(async () => {
  await loadSavedPosition();

  const userData = app.getPath('userData');
  herdrMonitor = new HerdrMonitor(userData);
  quotaManager = new QuotaManager(userData);

  quotaManager.on('change', () => {
    broadcastSnapshot();
  });

  herdrMonitor.on('change', () => {
    void (async () => {
      try {
        const state = herdrMonitor!.getState();
        if (quotaManager) {
          await quotaManager.collectAll(state.tasks, state.screens);
        }
        broadcastSnapshot();
      } catch (err) {
        logRuntimeError('herdrMonitor.change', err);
      }
    })();
  });

  ipcMain.handle('island:get-snapshot', () => buildSnapshot());

  ipcMain.on('island:set-interactive', (_event, interactive: boolean) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    // Never disable mouse events while actively dragging
    if (dragInterval) return;
    if (interactive) {
      mainWindow.setIgnoreMouseEvents(false);
    } else {
      mainWindow.setIgnoreMouseEvents(true, { forward: true });
    }
  });

  ipcMain.on('island:drag-start', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    stopMainDrag();
    mainWindow.setIgnoreMouseEvents(false);

    dragStartCursor = screen.getCursorScreenPoint();
    const bounds = mainWindow.getBounds();
    dragStartWinPos = [bounds.x, bounds.y];
    lastAppliedPos = [bounds.x, bounds.y];

    // 120Hz global cursor polling in Main Process: tracks fast cursor motion smoothly with zero IPC lag
    dragInterval = setInterval(() => {
      if (!mainWindow || mainWindow.isDestroyed() || !dragStartCursor || !dragStartWinPos) {
        stopMainDrag();
        return;
      }
      const cur = screen.getCursorScreenPoint();
      const nx = Math.round(dragStartWinPos[0] + (cur.x - dragStartCursor.x));
      const ny = Math.round(dragStartWinPos[1] + (cur.y - dragStartCursor.y));
      if (!lastAppliedPos || nx !== lastAppliedPos[0] || ny !== lastAppliedPos[1]) {
        lastAppliedPos = [nx, ny];
        mainWindow.setPosition(nx, ny, false);
      }
    }, 8);
  });

  ipcMain.on('island:drag-move', () => {
    // Handled natively at 120Hz by dragInterval in main process
  });

  ipcMain.on('island:drag-end', () => {
    stopMainDrag();
  });

  ipcMain.on('island:reset-position', () => {
    stopMainDrag();
    savedCustomPosition = null;
    void persistPosition(null);
    if (mainWindow && !mainWindow.isDestroyed()) {
      applyWindowPosition(mainWindow, getDefaultTopCenterPosition());
    }
  });

  ipcMain.handle('island:toggle-demo', () => {
    demoMode = !demoMode;
    if (demoMode) demoAnchorTime = Date.now();
    rebuildTrayMenu();
    const snap = buildSnapshot();
    broadcastSnapshot();
    return snap;
  });

  ipcMain.handle('island:toggle-pin', () => {
    pinned = !pinned;
    rebuildTrayMenu();
    const snap = buildSnapshot();
    broadcastSnapshot();
    return snap;
  });

  ipcMain.handle('island:refresh', async () => {
    await refreshAll(true);
    return buildSnapshot();
  });

  await createWindow();

  tray = new Tray(createTrayNativeImage());
  tray.setToolTip('Herdr Island · Agent 状态与额度只读监控');
  tray.on('click', () => {
    if (!mainWindow) return;
    pinned = !pinned;
    mainWindow.showInactive();
    broadcastSnapshot();
    rebuildTrayMenu();
  });
  rebuildTrayMenu();

  screen.on('display-metrics-changed', () => {
    if (mainWindow && !savedCustomPosition) applyWindowPosition(mainWindow);
    rebuildTrayMenu();
  });
  screen.on('display-added', () => rebuildTrayMenu());
  screen.on('display-removed', () => {
    savedCustomPosition = null;
    if (mainWindow) applyWindowPosition(mainWindow);
    rebuildTrayMenu();
  });

  await herdrMonitor.start();
  const initState = herdrMonitor.getState();
  await quotaManager.collectAll(initState.tasks, initState.screens);
  broadcastSnapshot();

  quotaTimer = setInterval(() => {
    void (async () => {
      try {
        if (!herdrMonitor || !quotaManager) return;
        const st = herdrMonitor.getState();
        await quotaManager.collectAll(st.tasks, st.screens);
        broadcastSnapshot();
      } catch (err) {
        logRuntimeError('quotaTimer', err);
      }
    })();
  }, 15000);
});

app.on('before-quit', () => {
  isQuitting = true;
  stopMainDrag();
  if (quotaTimer) clearInterval(quotaTimer);
  herdrMonitor?.stop();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
