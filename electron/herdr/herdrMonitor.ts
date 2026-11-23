import { ChildProcess, execFile, execFileSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { AgentTask, IslandAlert, TaskStatus } from '../../src/types/monitor';
import {
  detectAgentBrand,
  extractTaskMessages,
  extractTaskTitle,
  extractWorkspaceName,
  normalizeStatus,
} from './agentDetector';

/**
 * STRICT READ-ONLY ALLOWLIST (per AGENTS.md Section 1)
 * Never add mutating hc commands (`send`, `keys`, `kill`, `rm`, `run`, `label`, etc.).
 */
const ALLOWED_HC_SUBCOMMANDS = new Set(['ls', 'get', 'events', 'read'] as const);
type AllowedHcSubcommand = 'ls' | 'get' | 'events' | 'read';

interface PersistedTimerEntry {
  startedAt: number;
  statusChangedAt: number;
  lastStatus: TaskStatus;
  accumulatedMs?: number;
  turn?: number;
}

export interface TerminalScreenCache {
  terminalId: string;
  brand: AgentTask['brand'];
  screenText: string;
  updatedAt: number;
}

export class HerdrMonitor extends EventEmitter {
  private hcPath: string | null = null;
  private connected = false;
  private connectionHint: string | undefined;
  private tasks: AgentTask[] = [];
  private latestAlert: IslandAlert | null = null;
  private eventsProc: ChildProcess | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private refreshDebounce: NodeJS.Timeout | null = null;
  private isRefreshing = false;
  private stopped = false;

  private readonly timerCachePath: string;
  private timerMap = new Map<string, PersistedTimerEntry>();
  private screenCache = new Map<string, TerminalScreenCache>();
  private initializedOnce = false;

  constructor(userDataDir: string) {
    super();
    this.timerCachePath = path.join(userDataDir, 'timer-state.json');
  }

  public getState() {
    return {
      connected: this.connected,
      connectionHint: this.connectionHint,
      hcPath: this.hcPath ?? undefined,
      tasks: this.tasks,
      latestAlert: this.latestAlert,
      screens: Array.from(this.screenCache.values()),
    };
  }

  public async start(): Promise<void> {
    this.stopped = false;
    await this.loadTimerCache();
    this.hcPath = this.resolveHcBinary();

    if (!this.hcPath) {
      this.connected = false;
      this.connectionHint = '未检测到 hc.exe (herdr-core)';
      this.emit('change');
      return;
    }

    await this.refreshSnapshot(true);
    this.startEventsStream();

    this.pollTimer = setInterval(() => {
      void this.refreshSnapshot(false);
    }, 4000);
  }

  public stop(): void {
    this.stopped = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.refreshDebounce) clearTimeout(this.refreshDebounce);
    if (this.eventsProc) {
      this.eventsProc.kill();
      this.eventsProc = null;
    }
  }

  public async forceRefresh(): Promise<void> {
    await this.refreshSnapshot(true);
  }

  private resolveHcBinary(): string | null {
    const candidates = [
      process.env.HC_BIN,
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'herdr-core', 'hc.exe'),
      path.join(process.env.USERPROFILE || '', 'AppData', 'Local', 'Programs', 'herdr-core', 'hc.exe'),
      path.join(process.env.USERPROFILE || '', '.local', 'bin', 'hc.exe'),
      path.join(process.env.USERPROFILE || '', '.cargo', 'bin', 'hc.exe'),
    ].filter((p): p is string => Boolean(p));

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }

    try {
      const out = execFileSync('where.exe', ['hc.exe'], {
        timeout: 2000,
        windowsHide: true,
        encoding: 'utf8',
      });
      const first = out
        .split(/\r?\n/)
        .map((s) => s.trim())
        .find((s) => s && fs.existsSync(s));
      if (first) return first;
    } catch {
      // ignore if not on PATH
    }
    return null;
  }

  public assertReadOnlyCommand(subcommand: AllowedHcSubcommand, args: string[]): void {
    if (!ALLOWED_HC_SUBCOMMANDS.has(subcommand)) {
      throw new Error(`[ReadOnlyGuard] Forbidden hc subcommand: ${subcommand}`);
    }
    if (subcommand === 'read') {
      if (args[0] !== '--lines' || args[1] !== '0') {
        throw new Error('[ReadOnlyGuard] hc read MUST strictly pass --lines 0');
      }
    }
  }

  private execHc(
    subcommand: AllowedHcSubcommand,
    args: string[],
    timeoutMs = 4000,
  ): Promise<{ stdout: string; stderr: string }> {
    this.assertReadOnlyCommand(subcommand, args);
    const bin = this.hcPath;
    if (!bin) {
      return Promise.reject(new Error('hc binary not found'));
    }

    return new Promise((resolve, reject) => {
      execFile(
        bin,
        [subcommand, ...args],
        {
          timeout: timeoutMs,
          maxBuffer: 4 * 1024 * 1024,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (error) {
            const detail = stderr?.trim() || stdout?.trim() || error.message;
            reject(new Error(detail));
            return;
          }
          resolve({ stdout, stderr });
        },
      );
    });
  }

  private startEventsStream(): void {
    if (this.stopped || !this.hcPath || this.eventsProc) return;
    this.assertReadOnlyCommand('events', ['--json']);

    const child = spawn(this.hcPath, ['events', '--json'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.eventsProc = child;

    let buffer = '';
    child.stdout?.on('error', () => {});
    child.stderr?.on('error', () => {});
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      if (lines.some((l) => l.trim().length > 0)) {
        this.scheduleDebouncedRefresh();
      }
    });

    child.on('exit', () => {
      this.eventsProc = null;
      if (!this.stopped) {
        this.reconnectTimer = setTimeout(() => {
          this.startEventsStream();
        }, 3500);
      }
    });

    child.on('error', () => {
      this.eventsProc = null;
    });
  }

  private scheduleDebouncedRefresh(): void {
    if (this.refreshDebounce) clearTimeout(this.refreshDebounce);
    this.refreshDebounce = setTimeout(() => {
      void this.refreshSnapshot(false);
    }, 180);
  }

  private parseTerminalsOutput(stdout: string): Record<string, unknown>[] {
    const trimmed = stdout.trim();
    if (!trimmed) return [];

    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.filter((x): x is Record<string, unknown> => Boolean(x && typeof x === 'object'));
      }
      if (parsed && typeof parsed === 'object') {
        const obj = parsed as Record<string, unknown>;
        const arr = obj.terminals ?? obj.items ?? obj.list ?? obj.data;
        if (Array.isArray(arr)) {
          return arr.filter((x): x is Record<string, unknown> => Boolean(x && typeof x === 'object'));
        }
      }
    } catch {
      const list: Record<string, unknown>[] = [];
      for (const line of trimmed.split('\n')) {
        const l = line.trim();
        if (!l) continue;
        try {
          const item = JSON.parse(l) as unknown;
          if (item && typeof item === 'object' && !Array.isArray(item)) {
            list.push(item as Record<string, unknown>);
          }
        } catch {
          // ignore
        }
      }
      return list;
    }
    return [];
  }

  private parseTimestampMs(raw: Record<string, unknown>, keys: string[]): number | null {
    for (const key of keys) {
      const val = raw[key];
      if (typeof val === 'number' && Number.isFinite(val) && val > 0) {
        return val < 1e11 ? Math.round(val * 1000) : Math.round(val);
      }
      if (typeof val === 'string' && val.trim()) {
        const asNum = Number(val);
        if (Number.isFinite(asNum) && asNum > 0) {
          return asNum < 1e11 ? Math.round(asNum * 1000) : Math.round(asNum);
        }
        const parsed = Date.parse(val);
        if (!Number.isNaN(parsed)) return parsed;
      }
    }
    return null;
  }

  private async refreshSnapshot(forceReadAllScreens: boolean): Promise<void> {
    if (this.isRefreshing || this.stopped || !this.hcPath) return;
    this.isRefreshing = true;

    try {
      const { stdout } = await this.execHc('ls', ['--json']);
      const rawList = this.parseTerminalsOutput(stdout);
      this.connected = true;
      this.connectionHint = undefined;

      const now = Date.now();
      const nextTasks: AgentTask[] = [];
      let timerDirty = false;

      for (const item of rawList) {
        const id = String(item.address ?? item.id ?? item.terminal ?? item.name ?? '').trim();
        if (!id) continue;

        let mergedRaw: Record<string, unknown> = {
          ...item,
          ls_status: typeof item.status === 'string' ? item.status : undefined,
        };
        try {
          const detailRes = await this.execHc('get', [id, '--json'], 2500);
          const detailObj = JSON.parse(detailRes.stdout.trim()) as unknown;
          if (detailObj && typeof detailObj === 'object' && !Array.isArray(detailObj)) {
            mergedRaw = {
              ...mergedRaw,
              ...(detailObj as Record<string, unknown>),
            };
          }
        } catch {
          // Keep `ls` summary if `get` fails
        }

        const status = normalizeStatus(mergedRaw);
        const prevCachedScreen = this.screenCache.get(id);
        const prevTimer = this.timerMap.get(id);
        const statusJustChanged = prevTimer && prevTimer.lastStatus !== status;

        const shouldReadScreen =
          forceReadAllScreens ||
          !prevCachedScreen ||
          statusJustChanged ||
          status === 'working' ||
          status === 'blocked' ||
          now - prevCachedScreen.updatedAt > 15000;

        let screenText = prevCachedScreen?.screenText ?? '';
        if (shouldReadScreen) {
          try {
            const screenRes = await this.execHc('read', ['--lines', '0', id], 2500);
            screenText = screenRes.stdout;
          } catch {
            // Retain previous screen cache if read fails momentarily
          }
        }

        const { brand, brandLabel } = detectAgentBrand(mergedRaw, screenText);

        // Skip plain idle PowerShell/cmd tabs that aren't running any agent (turn 0 & idle)
        const turn = typeof mergedRaw.turn === 'number' ? mergedRaw.turn : undefined;
        if (brand === 'terminal' && status === 'idle' && (!turn || turn === 0)) {
          continue;
        }

        if (screenText) {
          this.screenCache.set(id, {
            terminalId: id,
            brand,
            screenText,
            updatedAt: now,
          });
        }

        const labels =
          mergedRaw.labels && typeof mergedRaw.labels === 'object'
            ? (mergedRaw.labels as Record<string, unknown>)
            : undefined;
        const foreground =
          mergedRaw.foreground && typeof mergedRaw.foreground === 'object'
            ? (mergedRaw.foreground as Record<string, unknown>)
            : undefined;
        const statusObj =
          mergedRaw.status && typeof mergedRaw.status === 'object'
            ? (mergedRaw.status as Record<string, unknown>)
            : undefined;

        const cwd = String(foreground?.cwd ?? mergedRaw.cwd ?? '').trim();
        const workspace = extractWorkspaceName(cwd, mergedRaw.where, labels);
        const name =
          typeof mergedRaw.name === 'string' && mergedRaw.name.trim()
            ? mergedRaw.name.trim()
            : id;
        const taskTitle = extractTaskTitle(mergedRaw, workspace, brandLabel, screenText);
        const statusMsg = typeof statusObj?.msg === 'string' ? statusObj.msg : undefined;
        const { fullMessage, liveAction, snippet } = extractTaskMessages(
          screenText,
          status,
          statusMsg,
        );

        // `status_ms` in herdr-core is the exact ms timestamp when the current status started!
        const statusMs = this.parseTimestampMs(mergedRaw, [
          'status_ms',
          'turn_started_at',
          'status_changed_at',
        ]);
        const createdMs = this.parseTimestampMs(mergedRaw, [
          'created_ms',
          'started_at',
          'created_at',
          'launched_at',
        ]);

        let timerEntry = prevTimer;
        if (!timerEntry) {
          timerEntry = {
            startedAt: statusMs ?? createdMs ?? now,
            statusChangedAt: statusMs ?? now,
            lastStatus: status,
            turn,
          };
          this.timerMap.set(id, timerEntry);
          timerDirty = true;
        } else {
          if (status === 'working' && statusMs) {
            timerEntry.startedAt = statusMs;
          }
          if (
            timerEntry.lastStatus !== status ||
            (turn !== undefined && turn !== timerEntry.turn)
          ) {
            const prevStatus = timerEntry.lastStatus;
            if (status === 'working' && prevStatus !== 'working') {
              timerEntry.startedAt = statusMs ?? now;
              timerEntry.accumulatedMs = undefined;
            } else if (prevStatus === 'working' && status !== 'working') {
              timerEntry.accumulatedMs = Math.max(1000, now - timerEntry.startedAt);
            }
            timerEntry.lastStatus = status;
            timerEntry.statusChangedAt = statusMs ?? now;
            timerEntry.turn = turn;
            timerDirty = true;

            if (this.initializedOnce) {
              this.maybeEmitTransitionAlert({
                id,
                brand,
                brandLabel,
                taskTitle,
                snippet,
                status,
                elapsedMs: timerEntry.accumulatedMs ?? now - timerEntry.startedAt,
              });
            }
          }
        }

        nextTasks.push({
          id,
          name,
          taskTitle,
          brand,
          brandLabel,
          status,
          workspace,
          cwd,
          startedAt: timerEntry.startedAt,
          statusChangedAt: timerEntry.statusChangedAt,
          accumulatedMs: timerEntry.accumulatedMs,
          snippet,
          fullMessage,
          liveAction,
          command:
            typeof foreground?.name === 'string'
              ? foreground.name
              : typeof mergedRaw.command === 'string'
                ? mergedRaw.command
                : undefined,
          turn,
        });
      }

      // Sort priority: blocked > working > error > done > idle
      const statusWeight: Record<TaskStatus, number> = {
        blocked: 0,
        working: 1,
        error: 2,
        done: 3,
        idle: 4,
      };
      nextTasks.sort((a, b) => {
        const diff = statusWeight[a.status] - statusWeight[b.status];
        if (diff !== 0) return diff;
        if (a.status === 'working' && b.status === 'working') {
          // Longest or most active working tasks cleanly ordered
          return a.startedAt - b.startedAt;
        }
        return b.statusChangedAt - a.statusChangedAt;
      });

      this.tasks = nextTasks;
      this.initializedOnce = true;
      if (timerDirty) {
        void this.saveTimerCache();
      }
      this.emit('change');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.connected = false;
      if (/os error 5|拒绝访问|access is denied/i.test(msg)) {
        this.connectionHint = 'Herdr 管道权限不匹配（请以相同桌面普通用户权限运行）';
      } else {
        this.connectionHint = '等待 Herdr Core 启动连接...';
      }
      this.emit('change');
    } finally {
      this.isRefreshing = false;
    }
  }

  private maybeEmitTransitionAlert(params: {
    id: string;
    brand: AgentTask['brand'];
    brandLabel: string;
    taskTitle: string;
    snippet: string;
    status: TaskStatus;
    elapsedMs: number;
  }): void {
    if (params.status !== 'blocked' && params.status !== 'done' && params.status !== 'error') {
      return;
    }

    this.latestAlert = {
      id: `${params.id}-${params.status}-${Date.now()}`,
      kind: params.status,
      brand: params.brand,
      brandLabel: params.brandLabel,
      title: params.taskTitle,
      subtitle: params.snippet,
      elapsedMs: params.elapsedMs,
      timestamp: Date.now(),
    };
  }

  private async loadTimerCache(): Promise<void> {
    try {
      const raw = await fsp.readFile(this.timerCachePath, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, PersistedTimerEntry>;
      for (const [k, v] of Object.entries(parsed)) {
        if (v && typeof v.startedAt === 'number') {
          this.timerMap.set(k, v);
        }
      }
    } catch {
      // ignore
    }
  }

  private async saveTimerCache(): Promise<void> {
    try {
      const obj: Record<string, PersistedTimerEntry> = {};
      for (const [k, v] of this.timerMap.entries()) {
        obj[k] = v;
      }
      await fsp.mkdir(path.dirname(this.timerCachePath), { recursive: true });
      await fsp.writeFile(this.timerCachePath, JSON.stringify(obj), 'utf8');
    } catch {
      // ignore
    }
  }
}
