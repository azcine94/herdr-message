import { execFile, execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { AgentBrand, AgentTask, ProviderQuota, QuotaWindow } from '../../src/types/monitor';
import { getBrandLabel, stripAnsi } from '../herdr/agentDetector';
import { TerminalScreenCache } from '../herdr/herdrMonitor';

interface DailyWorkTelemetry {
  date: string;
  devinMs: number;
  agyMs: number;
  lastTickAt: number;
}

interface PersistedAgyQuotaCache {
  gemini5h?: QuotaWindow;
  geminiWeekly?: QuotaWindow;
  claudeGpt5h?: QuotaWindow;
  claudeGptWeekly?: QuotaWindow;
  creditsText?: string;
  capturedAt: number;
}

interface PersistedDevinQuotaCache {
  plan?: string;
  daily?: QuotaWindow;
  weekly?: QuotaWindow;
  capturedAt: number;
}

interface IslandUserConfig {
  devinApiKey?: string;
  devinApiUrl?: string;
}

const AGY_POLL_COOLDOWN_MS = 120 * 1000;        // Auto-refresh AGY every 2 minutes
const DEVIN_POLL_COOLDOWN_MS = 150 * 1000;      // Auto-refresh Devin every 2.5 minutes
const POST_TASK_MIN_DEBOUNCE_MS = 15 * 1000;    // Minimum gap when triggered by task completion

function formatResetCountdown(resetsAtMs?: number): string | undefined {
  if (!resetsAtMs || !Number.isFinite(resetsAtMs)) return undefined;
  const diffMs = resetsAtMs - Date.now();
  if (diffMs <= 0) return '即将重置';
  const totalMinutes = Math.ceil(diffMs / 60000);
  if (totalMinutes < 60) return `${totalMinutes}m 后重置`;
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  if (hours < 24) return mins > 0 ? `${hours}h ${mins}m 后重置` : `${hours}h 后重置`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d ${remHours}h 后重置` : `${days}d 后重置`;
}

function execReadOnlyCli(bin: string, args: string[], timeoutMs = 9000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
      },
      (err, stdout) => {
        if (err && !stdout) {
          resolve(null);
          return;
        }
        resolve(stdout || null);
      },
    );
  });
}

function resolveBinaryOnPath(exeName: string): string | null {
  try {
    const out = execFileSync('where.exe', [exeName], {
      timeout: 2000,
      windowsHide: true,
      encoding: 'utf8',
    });
    const first = out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find((s) => s && fs.existsSync(s));
    return first ?? null;
  } catch {
    return null;
  }
}

export class QuotaManager extends EventEmitter {
  private quotas: ProviderQuota[] = [];
  private readonly homeDir = os.homedir();
  private readonly customDir: string;
  private readonly configPath: string;
  private readonly telemetryPath: string;
  private readonly agyQuotaCachePath: string;
  private readonly devinQuotaCachePath: string;
  private telemetry: DailyWorkTelemetry;

  private agyCache: PersistedAgyQuotaCache | null = null;
  private devinCache: PersistedDevinQuotaCache | null = null;

  private lastAgyCliFetchAt = 0;
  private isFetchingAgyCli = false;
  private lastDevinCliFetchAt = 0;
  private isFetchingDevinCli = false;
  private lastDevinApiFetchAt = 0;
  private cachedDevinApiBadge: string | undefined;

  // Track previous working tasks so finishing a turn immediately triggers fresh quota query
  private prevWorkingAgyIds = new Set<string>();
  private prevWorkingDevinIds = new Set<string>();
  private lastTasksSnapshot: AgentTask[] = [];
  private lastScreensSnapshot: TerminalScreenCache[] = [];

  private resolvedAgyBin: string | null | undefined;
  private resolvedDevinBin: string | null | undefined;
  private resolvedPythonBin: string | null | undefined;

  constructor(userDataDir: string) {
    super();
    this.customDir = path.join(this.homeDir, '.herdr-island', 'quotas');
    this.configPath = path.join(this.homeDir, '.herdr-island', 'config.json');
    this.telemetryPath = path.join(userDataDir, 'daily-telemetry.json');
    this.agyQuotaCachePath = path.join(userDataDir, 'agy-quota-cache-v2.json');
    this.devinQuotaCachePath = path.join(userDataDir, 'devin-quota-cache-v1.json');
    this.telemetry = {
      date: this.todayKey(),
      devinMs: 0,
      agyMs: 0,
      lastTickAt: Date.now(),
    };
    void this.loadCaches();
  }

  public getQuotas(): ProviderQuota[] {
    return this.quotas;
  }

  public getCustomQuotasDir(): string {
    return this.customDir;
  }

  public async collectAll(
    tasks: AgentTask[],
    screens: TerminalScreenCache[],
    options?: { force?: boolean; waitForProbes?: boolean },
  ): Promise<ProviderQuota[]> {
    this.lastTasksSnapshot = tasks;
    this.lastScreensSnapshot = screens;
    this.tickWorkingTelemetry(tasks);

    const force = Boolean(options?.force);
    const waitForProbes = Boolean(options?.waitForProbes);

    // Detect if any AGY or Devin task just finished `working` -> trigger immediate refresh!
    const currentWorkingAgy = new Set(
      tasks.filter((t) => t.brand === 'agy' && t.status === 'working').map((t) => t.id),
    );
    const currentWorkingDevin = new Set(
      tasks.filter((t) => t.brand === 'devin' && t.status === 'working').map((t) => t.id),
    );

    let agyJustFinished = false;
    for (const prevId of this.prevWorkingAgyIds) {
      if (!currentWorkingAgy.has(prevId)) agyJustFinished = true;
    }
    let devinJustFinished = false;
    for (const prevId of this.prevWorkingDevinIds) {
      if (!currentWorkingDevin.has(prevId)) devinJustFinished = true;
    }

    this.prevWorkingAgyIds = currentWorkingAgy;
    this.prevWorkingDevinIds = currentWorkingDevin;

    const now = Date.now();
    const agyBin = this.resolveAgyBinary();
    const devinBin = this.resolveDevinBinary();

    const shouldProbeAgy =
      Boolean(agyBin) &&
      (force ||
        now - this.lastAgyCliFetchAt >= AGY_POLL_COOLDOWN_MS ||
        (agyJustFinished && now - this.lastAgyCliFetchAt >= POST_TASK_MIN_DEBOUNCE_MS));

    const shouldProbeDevin =
      Boolean(devinBin) &&
      (force ||
        now - this.lastDevinCliFetchAt >= DEVIN_POLL_COOLDOWN_MS ||
        (devinJustFinished && now - this.lastDevinCliFetchAt >= POST_TASK_MIN_DEBOUNCE_MS));

    if (waitForProbes) {
      await Promise.all([
        shouldProbeAgy && agyBin ? this.refreshAgyUsageViaOfficialCli(agyBin) : Promise.resolve(),
        shouldProbeDevin && devinBin
          ? this.refreshDevinUsageViaOfficialCli(devinBin)
          : Promise.resolve(),
      ]);
    } else {
      // Non-blocking background probes: emit 'change' immediately as each finishes!
      if (shouldProbeAgy && agyBin) {
        void this.refreshAgyUsageViaOfficialCli(agyBin).then(() => {
          void this.rebuildQuotasOnly().then(() => this.emit('change'));
        });
      }
      if (shouldProbeDevin && devinBin) {
        void this.refreshDevinUsageViaOfficialCli(devinBin).then(() => {
          void this.rebuildQuotasOnly().then(() => this.emit('change'));
        });
      }
    }

    return this.rebuildQuotasOnly();
  }

  private async rebuildQuotasOnly(): Promise<ProviderQuota[]> {
    const tasks = this.lastTasksSnapshot;
    const screens = this.lastScreensSnapshot;

    const results = await Promise.all([
      this.collectCodexQuota(screens),
      this.buildAgyQuotasFromCache(tasks, screens),
      this.buildDevinQuotaFromCache(tasks, screens),
      this.collectScreenAgentQuotas(screens),
      this.collectCustomJsonQuotas(),
    ]);

    const merged = new Map<string, ProviderQuota>();
    for (const entry of results.flat()) {
      if (!entry) continue;
      merged.set(entry.id, entry);
    }

    this.quotas = Array.from(merged.values());
    return this.quotas;
  }

  private todayKey(): string {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
      now.getDate(),
    ).padStart(2, '0')}`;
  }

  private tickWorkingTelemetry(tasks: AgentTask[]): void {
    const now = Date.now();
    const today = this.todayKey();
    if (this.telemetry.date !== today) {
      this.telemetry = { date: today, devinMs: 0, agyMs: 0, lastTickAt: now };
    }

    const delta = Math.max(0, Math.min(20000, now - this.telemetry.lastTickAt));
    this.telemetry.lastTickAt = now;

    let dirty = false;
    if (delta > 0) {
      if (tasks.some((t) => t.brand === 'devin' && t.status === 'working')) {
        this.telemetry.devinMs += delta;
        dirty = true;
      }
      if (tasks.some((t) => t.brand === 'agy' && t.status === 'working')) {
        this.telemetry.agyMs += delta;
        dirty = true;
      }
    }

    if (dirty) {
      void this.saveTelemetry();
    }
  }

  // ---------------------------------------------------------------------------
  // 1. Codex: Deep Multi-Chunk Scan across recent .jsonl files by true timestamp
  // ---------------------------------------------------------------------------
  private async collectCodexQuota(
    screens: TerminalScreenCache[],
  ): Promise<ProviderQuota | null> {
    const codexHome = process.env.CODEX_HOME || path.join(this.homeDir, '.codex');
    const sessionsRoot = path.join(codexHome, 'sessions');
    const archivedRoot = path.join(codexHome, 'archived_sessions');

    const [activeFiles, archivedFiles] = await Promise.all([
      this.collectRecentSessionFiles(sessionsRoot, 80),
      this.collectRecentSessionFiles(archivedRoot, 15),
    ]);
    const candidateFiles = [...activeFiles, ...archivedFiles];

    let newestRecord: { eventTimeMs: number; quota: ProviderQuota } | null = null;

    for (const filePath of candidateFiles) {
      const parsed = await this.parseCodexJsonlLatestEvent(filePath);
      if (parsed && (!newestRecord || parsed.eventTimeMs > newestRecord.eventTimeMs)) {
        newestRecord = parsed;
      }
    }

    if (newestRecord) {
      return newestRecord.quota;
    }

    // Fallback: terminal `/statusline`
    for (const s of screens) {
      if (s.brand !== 'codex') continue;
      const tail = stripAnsi(s.screenText).split('\n').slice(-5).join(' ');
      const fiveHourMatch = tail.match(/(?:5h|five-hour)[^\d]{0,12}(\d{1,3})%/i);
      const weeklyMatch = tail.match(/(?:week|weekly|7d)[^\d]{0,12}(\d{1,3})%/i);
      if (fiveHourMatch || weeklyMatch) {
        const primaryPct = fiveHourMatch ? Math.min(100, Number(fiveHourMatch[1])) : undefined;
        const secondaryPct = weeklyMatch ? Math.min(100, Number(weeklyMatch[1])) : undefined;
        return {
          id: 'codex',
          brand: 'codex',
          name: 'Codex',
          primary:
            primaryPct !== undefined
              ? { label: '5h 窗口', remainingPct: primaryPct, usedPct: 100 - primaryPct }
              : undefined,
          secondary:
            secondaryPct !== undefined
              ? { label: '周额度', remainingPct: secondaryPct, usedPct: 100 - secondaryPct }
              : undefined,
          lowQuota: primaryPct !== undefined && primaryPct <= 15,
          updatedAt: s.updatedAt,
          source: 'statusline',
        };
      }
    }

    return null;
  }

  private async collectRecentSessionFiles(dir: string, maxFiles: number): Promise<string[]> {
    if (!fs.existsSync(dir)) return [];
    const found: string[] = [];

    const walkDescending = async (currentDir: string, depth: number) => {
      if (depth > 4 || found.length >= maxFiles) return;
      let entries: fs.Dirent[];
      try {
        entries = await fsp.readdir(currentDir, { withFileTypes: true });
      } catch {
        return;
      }

      entries.sort((a, b) => b.name.localeCompare(a.name));

      for (const entry of entries) {
        if (found.length >= maxFiles) break;
        const full = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          await walkDescending(full, depth + 1);
        } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          found.push(full);
        }
      }
    };

    await walkDescending(dir, 0);
    return found;
  }

  private async parseCodexJsonlLatestEvent(
    filePath: string,
  ): Promise<{ eventTimeMs: number; quota: ProviderQuota } | null> {
    let handle: fsp.FileHandle | null = null;
    try {
      handle = await fsp.open(filePath, 'r');
      const stat = await handle.stat();
      if (stat.size === 0) return null;

      // Step backwards in 1MB windows (up to 4MB deep) so huge tool outputs never hide rate_limits
      const windowBytes = 1024 * 1024;
      const maxSteps = 4;

      for (let step = 0; step < maxSteps; step++) {
        const endPos = stat.size - step * windowBytes;
        if (endPos <= 0) break;
        const startPos = Math.max(0, endPos - windowBytes);
        const readLen = endPos - startPos;

        const buffer = Buffer.alloc(readLen);
        await handle.read(buffer, 0, readLen, startPos);

        const lines = buffer.toString('utf8').split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i].trim();
          if (!line || !line.includes('rate_limits')) continue;
          try {
            const obj = JSON.parse(line) as Record<string, unknown>;
            const payload = (obj.payload as Record<string, unknown> | undefined) ?? obj;
            const info = (payload.info as Record<string, unknown> | undefined) ?? payload;
            const rl = (info.rate_limits ?? payload.rate_limits ?? obj.rate_limits) as
              | Record<string, unknown>
              | undefined;
            if (!rl || typeof rl !== 'object') continue;

            const primaryWindow = this.parseCodexWindow(
              rl.primary as Record<string, unknown> | undefined,
              '5h 窗口',
            );
            const secondaryWindow = this.parseCodexWindow(
              rl.secondary as Record<string, unknown> | undefined,
              '周额度',
            );

            if (!primaryWindow && !secondaryWindow) continue;

            const tsStr = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : NaN;
            const eventTimeMs = Number.isFinite(tsStr) ? tsStr : stat.mtimeMs;

            const mainWin = primaryWindow ?? secondaryWindow!;
            const planType =
              typeof rl.plan_type === 'string' ? rl.plan_type.toUpperCase() : undefined;

            return {
              eventTimeMs,
              quota: {
                id: 'codex',
                brand: 'codex',
                name: 'Codex',
                primary: primaryWindow,
                secondary: secondaryWindow,
                badgeText: `剩 ${mainWin.remainingPct}%`,
                subText: `已用 ${mainWin.usedPct}%${
                  mainWin.resetText ? ` · ${mainWin.resetText}` : planType ? ` · ${planType}` : ''
                }`,
                lowQuota:
                  (primaryWindow !== undefined && primaryWindow.remainingPct <= 15) ||
                  (secondaryWindow !== undefined && secondaryWindow.remainingPct <= 10),
                updatedAt: eventTimeMs,
                source: 'jsonl',
              },
            };
          } catch {
            // continue scanning earlier lines
          }
        }
      }
    } catch {
      return null;
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
    return null;
  }

  private parseCodexWindow(
    win: Record<string, unknown> | undefined,
    fallbackLabel: string,
  ): QuotaWindow | undefined {
    if (!win || typeof win !== 'object') return undefined;

    let remainingPct: number | undefined;
    let usedPct: number | undefined;
    if (typeof win.used_percent === 'number') {
      usedPct = Math.max(0, Math.min(100, Math.round(win.used_percent)));
      remainingPct = 100 - usedPct;
    } else if (typeof win.remaining_percent === 'number') {
      remainingPct = Math.max(0, Math.min(100, Math.round(win.remaining_percent)));
      usedPct = 100 - remainingPct;
    }
    if (remainingPct === undefined || usedPct === undefined) return undefined;

    let resetsAt: number | undefined;
    if (typeof win.resets_at === 'number' && win.resets_at > 0) {
      resetsAt = win.resets_at < 1e11 ? win.resets_at * 1000 : win.resets_at;
    } else if (typeof win.resets_at === 'string') {
      const parsed = Date.parse(win.resets_at);
      if (!Number.isNaN(parsed)) resetsAt = parsed;
    } else if (typeof win.resets_in_seconds === 'number' && win.resets_in_seconds > 0) {
      resetsAt = Date.now() + win.resets_in_seconds * 1000;
    }

    const windowMinutes = typeof win.window_minutes === 'number' ? win.window_minutes : undefined;
    const label =
      windowMinutes === 300
        ? '5h 窗口'
        : windowMinutes && windowMinutes >= 10000
          ? '周额度'
          : fallbackLabel;

    return {
      label,
      remainingPct,
      usedPct,
      resetsAt,
      resetText: formatResetCountdown(resetsAt),
    };
  }

  // ---------------------------------------------------------------------------
  // 2. AGY / Google Antigravity (`agy.exe -p "/usage"`)
  // ---------------------------------------------------------------------------
  private resolveAgyBinary(): string | null {
    if (this.resolvedAgyBin !== undefined) return this.resolvedAgyBin;
    const candidates = [
      process.env.AGY_BIN,
      path.join(process.env.LOCALAPPDATA || '', 'agy', 'bin', 'agy.exe'),
      path.join(this.homeDir, 'AppData', 'Local', 'agy', 'bin', 'agy.exe'),
    ].filter((x): x is string => Boolean(x));

    for (const c of candidates) {
      if (fs.existsSync(c)) {
        this.resolvedAgyBin = c;
        return c;
      }
    }
    this.resolvedAgyBin = resolveBinaryOnPath('agy.exe');
    return this.resolvedAgyBin;
  }

  private async refreshAgyUsageViaOfficialCli(agyBin: string): Promise<void> {
    if (this.isFetchingAgyCli) return;
    this.isFetchingAgyCli = true;
    this.lastAgyCliFetchAt = Date.now();

    try {
      const out = await execReadOnlyCli(agyBin, ['-p', '/usage'], 10000);
      if (!out) return;

      const nextCache: PersistedAgyQuotaCache = {
        ...this.agyCache,
        capturedAt: Date.now(),
      };

      for (const rawLine of stripAnsi(out).split('\n')) {
        const line = rawLine.trim();
        if (!line) continue;
        const pctMatch = line.match(/(\d{1,3})%/);
        if (!pctMatch) continue;
        const pct = Math.max(0, Math.min(100, Number(pctMatch[1])));
        const isoMatch = line.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/);
        const resetsAt = isoMatch ? Date.parse(isoMatch[0]) : undefined;
        const resetText = formatResetCountdown(resetsAt);

        const isGemini = /gemini/i.test(line);
        const isClaudeGpt = /claude|gpt/i.test(line);
        const isFiveHour = /five\s*hour|5h|5-hour/i.test(line);
        const isWeekly = /weekly|week|7d/i.test(line);

        if (isGemini && isFiveHour) {
          nextCache.gemini5h = {
            label: 'Gemini 5h',
            remainingPct: pct,
            usedPct: 100 - pct,
            resetsAt,
            resetText,
          };
        } else if (isGemini && isWeekly) {
          nextCache.geminiWeekly = {
            label: 'Gemini 周额度',
            remainingPct: pct,
            usedPct: 100 - pct,
            resetsAt,
            resetText,
          };
        } else if (isClaudeGpt && isFiveHour) {
          nextCache.claudeGpt5h = {
            label: 'Claude/GPT 5h',
            remainingPct: pct,
            usedPct: 100 - pct,
            resetsAt,
            resetText,
          };
        } else if (isClaudeGpt && isWeekly) {
          nextCache.claudeGptWeekly = {
            label: 'Claude/GPT 周额度',
            remainingPct: pct,
            usedPct: 100 - pct,
            resetsAt,
            resetText,
          };
        }
      }

      if (nextCache.gemini5h || nextCache.geminiWeekly || nextCache.claudeGptWeekly) {
        this.agyCache = nextCache;
        await this.saveAgyCache();
      }
    } finally {
      this.isFetchingAgyCli = false;
    }
  }

  private async buildAgyQuotasFromCache(
    tasks: AgentTask[],
    screens: TerminalScreenCache[],
  ): Promise<ProviderQuota[]> {
    const agyBin = this.resolveAgyBinary();

    let creditsValue: string | undefined;
    for (const s of screens) {
      if (s.brand !== 'agy') continue;
      const clean = stripAnsi(s.screenText);
      const creditsMatch = clean.match(/AI Credits:\s*([0-9]+(?:\.[0-9]+)?)/i);
      if (creditsMatch && Number(creditsMatch[1]) > 0) {
        creditsValue = `${creditsMatch[1]} Credits`;
      }
    }

    const out: ProviderQuota[] = [];
    const cache = this.agyCache;

    if (cache && (cache.gemini5h || cache.geminiWeekly)) {
      const g5 = cache.gemini5h
        ? { ...cache.gemini5h, resetText: formatResetCountdown(cache.gemini5h.resetsAt) }
        : undefined;
      const gw = cache.geminiWeekly
        ? { ...cache.geminiWeekly, resetText: formatResetCountdown(cache.geminiWeekly.resetsAt) }
        : undefined;
      const minPct = Math.min(g5?.remainingPct ?? 100, gw?.remainingPct ?? 100);

      out.push({
        id: 'agy',
        brand: 'agy',
        name: 'AGY · Gemini',
        primary: g5,
        secondary: gw,
        badgeText: creditsValue ?? `5h ${g5?.remainingPct ?? gw?.remainingPct}%`,
        subText: g5?.resetText ?? gw?.resetText,
        lowQuota: minPct <= 15,
        updatedAt: cache.capturedAt,
        source: 'api',
      });

      if (cache.claudeGpt5h || cache.claudeGptWeekly) {
        const c5 = cache.claudeGpt5h
          ? { ...cache.claudeGpt5h, resetText: formatResetCountdown(cache.claudeGpt5h.resetsAt) }
          : undefined;
        const cw = cache.claudeGptWeekly
          ? {
              ...cache.claudeGptWeekly,
              resetText: formatResetCountdown(cache.claudeGptWeekly.resetsAt),
            }
          : undefined;
        const cMin = Math.min(c5?.remainingPct ?? 100, cw?.remainingPct ?? 100);

        out.push({
          id: 'agy-claude-gpt',
          brand: 'agy',
          name: 'AGY · Claude/GPT',
          primary: c5,
          secondary: cw,
          badgeText: `周 ${cw?.remainingPct ?? c5?.remainingPct}%`,
          subText: cw?.resetText ?? c5?.resetText,
          lowQuota: cMin <= 15,
          updatedAt: cache.capturedAt,
          source: 'api',
        });
      }

      return out;
    }

    if (tasks.some((t) => t.brand === 'agy') || agyBin) {
      out.push({
        id: 'agy',
        brand: 'agy',
        name: 'Antigravity',
        badgeText: creditsValue ?? '同步中',
        subText: '正在查询 /usage 配额...',
        updatedAt: Date.now(),
        source: 'statusline',
      });
    }

    return out;
  }

  // ---------------------------------------------------------------------------
  // 3. Devin (`/usage` via Python or built-in Windows PowerShell ConPTY fallback)
  // ---------------------------------------------------------------------------
  private resolveDevinBinary(): string | null {
    if (this.resolvedDevinBin !== undefined) return this.resolvedDevinBin;
    const candidates = [
      process.env.DEVIN_BIN,
      path.join(process.env.LOCALAPPDATA || '', 'devin', 'cli', 'bin', 'devin.exe'),
      path.join(this.homeDir, 'AppData', 'Local', 'devin', 'cli', 'bin', 'devin.exe'),
    ].filter((x): x is string => Boolean(x));

    for (const c of candidates) {
      if (fs.existsSync(c)) {
        this.resolvedDevinBin = c;
        return c;
      }
    }
    this.resolvedDevinBin = resolveBinaryOnPath('devin.exe');
    return this.resolvedDevinBin;
  }

  private resolvePythonBinary(): string | null {
    if (this.resolvedPythonBin !== undefined) return this.resolvedPythonBin;
    const candidates = [
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python313', 'python.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python312', 'python.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python311', 'python.exe'),
    ];
    for (const c of candidates) {
      if (c && fs.existsSync(c)) {
        this.resolvedPythonBin = c;
        return c;
      }
    }
    const onPath = resolveBinaryOnPath('python.exe');
    // Skip WindowsApps Microsoft Store stub `python.exe` (0-byte alias)
    if (onPath && !/WindowsApps/i.test(onPath)) {
      this.resolvedPythonBin = onPath;
      return onPath;
    }
    this.resolvedPythonBin = null;
    return null;
  }

  private resolveProbeAsset(filename: string): string | null {
    const candidates = [
      path.resolve(__dirname, '..', '..', '..', 'electron', 'quota', filename),
      path.resolve(process.cwd(), 'electron', 'quota', filename),
    ];
    return candidates.find((p) => fs.existsSync(p)) ?? null;
  }

  private async runDevinConPtyOutput(devinBin: string): Promise<string | null> {
    const pyBin = this.resolvePythonBinary();
    const pyScript = this.resolveProbeAsset('devinUsageProbe.py');
    if (pyBin && pyScript) {
      const out = await execReadOnlyCli(pyBin, [pyScript, devinBin], 10000);
      if (out) return out;
    }

    // Zero-dependency fallback for Windows machines without Python installed!
    const psScript = this.resolveProbeAsset('devinUsageProbe.ps1');
    if (psScript) {
      return execReadOnlyCli(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psScript, '-DevinBin', devinBin],
        12000,
      );
    }
    return null;
  }

  private async refreshDevinUsageViaOfficialCli(devinBin: string): Promise<void> {
    if (this.isFetchingDevinCli) return;
    this.isFetchingDevinCli = true;
    this.lastDevinCliFetchAt = Date.now();

    try {
      const out = await this.runDevinConPtyOutput(devinBin);
      if (!out) return;

      const clean = stripAnsi(out)
        .replace(/[\r\u0000-\u0008\u000b-\u001f]/g, ' ')
        .replace(/\s+/g, ' ');

      const parsed: {
        plan?: string;
        dailyRemainingPct?: number;
        dailyReset?: string;
        weeklyRemainingPct?: number;
        weeklyReset?: string;
      } = {};

      const bannerMatch = clean.match(
        /\b(Max|Pro|Team|Plus|Enterprise)\s*·\s*(\d{1,3})%\s*remaining(?:\s*\(resets in ([^)]+)\))?/i,
      );
      if (bannerMatch) {
        parsed.plan = bannerMatch[1].trim();
        parsed.weeklyRemainingPct = Number(bannerMatch[2]);
        if (bannerMatch[3]) parsed.weeklyReset = bannerMatch[3].trim();
      }

      const dailyMatch = clean.match(
        /\bDaily\s+[^\d%]{0,40}(\d{1,3})%\s*(used|remaining)(?:.{0,30}?resets in\s+([0-9dhms ]+?)(?:\s{2,}|No usage|$))?/i,
      );
      if (dailyMatch) {
        const val = Number(dailyMatch[1]);
        parsed.dailyRemainingPct =
          dailyMatch[2].toLowerCase() === 'used' ? 100 - val : val;
        if (dailyMatch[3]) parsed.dailyReset = dailyMatch[3].trim();
      }

      const weeklyMatch = clean.match(
        /\bWeekly\s+[^\d%]{0,40}(\d{1,3})%\s*(used|remaining)(?:.{0,30}?resets in\s+([0-9dhms ]+?)(?:\s{2,}|No usage|$))?/i,
      );
      if (weeklyMatch) {
        const val = Number(weeklyMatch[1]);
        parsed.weeklyRemainingPct =
          weeklyMatch[2].toLowerCase() === 'used' ? 100 - val : val;
        if (weeklyMatch[3]) parsed.weeklyReset = weeklyMatch[3].trim();
      }

      const next: PersistedDevinQuotaCache = {
        plan: parsed.plan ?? this.devinCache?.plan,
        capturedAt: Date.now(),
      };

      if (typeof parsed.dailyRemainingPct === 'number') {
        const pct = Math.max(0, Math.min(100, parsed.dailyRemainingPct));
        next.daily = {
          label: '今日配额',
          remainingPct: pct,
          usedPct: 100 - pct,
          resetText: parsed.dailyReset ? `${parsed.dailyReset} 后重置` : undefined,
        };
      }

      if (typeof parsed.weeklyRemainingPct === 'number') {
        const pct = Math.max(0, Math.min(100, parsed.weeklyRemainingPct));
        next.weekly = {
          label: '周额度',
          remainingPct: pct,
          usedPct: 100 - pct,
          resetText: parsed.weeklyReset ? `${parsed.weeklyReset} 后重置` : undefined,
        };
      }

      if (next.daily || next.weekly) {
        this.devinCache = next;
        await this.saveDevinCache();
      }
    } catch {
      // ignore transient probe errors
    } finally {
      this.isFetchingDevinCli = false;
    }
  }

  private async buildDevinQuotaFromCache(
    tasks: AgentTask[],
    screens: TerminalScreenCache[],
  ): Promise<ProviderQuota | null> {
    const devinBin = this.resolveDevinBinary();
    const devinTasks = tasks.filter((t) => t.brand === 'devin');
    let acuText: string | undefined;
    let modelName: string | undefined;

    for (const s of screens) {
      if (s.brand !== 'devin') continue;
      const clean = stripAnsi(s.screenText);
      const tailLines = clean.split('\n').slice(-8).join('\n');

      const acuMatch = tailLines.match(/(\d+(?:\.\d+)?)\s*ACUs?/i);
      if (acuMatch) acuText = `${acuMatch[1]} ACU`;

      const footerLast =
        clean
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .pop() ?? '';
      const modelMatch = footerLast.match(
        /^([A-Za-z0-9 .\-+]+?)\s*·\s*(?:bypass|auto|ask|plan)/i,
      );
      if (modelMatch) modelName = modelMatch[1].trim();
    }

    const userCfg = await this.readOptionalUserConfig();
    if (userCfg?.devinApiKey && Date.now() - this.lastDevinApiFetchAt > 5 * 60 * 1000) {
      this.lastDevinApiFetchAt = Date.now();
      const apiBadge = await this.fetchDevinOfficialBalance(userCfg);
      if (apiBadge) this.cachedDevinApiBadge = apiBadge;
    }

    if (this.devinCache && (this.devinCache.daily || this.devinCache.weekly)) {
      const primaryWin = this.devinCache.daily ?? this.devinCache.weekly;
      const secondaryWin = this.devinCache.daily ? this.devinCache.weekly : undefined;
      const mainWin = primaryWin!;

      const subParts: string[] = [];
      if (this.devinCache.plan) subParts.push(`Devin ${this.devinCache.plan}`);
      subParts.push(`已用 ${mainWin.usedPct}%`);
      if (mainWin.resetText) subParts.push(mainWin.resetText);
      else if (modelName) subParts.push(modelName);

      return {
        id: 'devin',
        brand: 'devin',
        name: 'Devin',
        primary: primaryWin,
        secondary: secondaryWin,
        badgeText: this.cachedDevinApiBadge ?? acuText ?? `剩 ${mainWin.remainingPct}%`,
        subText: subParts.join(' · '),
        lowQuota: mainWin.remainingPct <= 15,
        updatedAt: this.devinCache.capturedAt,
        source: 'api',
      };
    }

    if (devinTasks.length === 0 && !devinBin) {
      return null;
    }

    return {
      id: 'devin',
      brand: 'devin',
      name: 'Devin',
      badgeText: this.cachedDevinApiBadge ?? acuText ?? '同步中',
      subText: modelName ?? '正在查询 /usage 配额...',
      updatedAt: Date.now(),
      source: 'telemetry',
    };
  }

  private async readOptionalUserConfig(): Promise<IslandUserConfig | null> {
    try {
      const raw = await fsp.readFile(this.configPath, 'utf8');
      return JSON.parse(raw) as IslandUserConfig;
    } catch {
      return null;
    }
  }

  private fetchDevinOfficialBalance(cfg: IslandUserConfig): Promise<string | null> {
    const { devinApiKey, devinApiUrl } = cfg;
    if (!devinApiKey || !devinApiUrl) return Promise.resolve(null);
    return new Promise((resolve) => {
      try {
        const req = https.get(
          devinApiUrl,
          {
            headers: {
              Authorization: `Bearer ${devinApiKey}`,
              Accept: 'application/json',
            },
            timeout: 4000,
          },
          (res) => {
            let body = '';
            res.on('data', (d: Buffer) => {
              body += d.toString('utf8');
            });
            res.on('end', () => {
              try {
                const parsed = JSON.parse(body) as Record<string, unknown>;
                const acu = parsed.remaining_acus ?? parsed.acu_remaining ?? parsed.balance;
                if (typeof acu === 'number') {
                  resolve(`${acu.toFixed(1)} ACU`);
                  return;
                }
              } catch {
                // ignore
              }
              resolve(null);
            });
          },
        );
        req.on('error', () => resolve(null));
        req.on('timeout', () => {
          req.destroy();
          resolve(null);
        });
      } catch {
        resolve(null);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // 4. Other Agents in Herdr + Custom JSON Drop-in
  // ---------------------------------------------------------------------------
  private async collectScreenAgentQuotas(
    screens: TerminalScreenCache[],
  ): Promise<ProviderQuota[]> {
    const out: ProviderQuota[] = [];
    const seen = new Set<string>();

    for (const s of screens) {
      if (s.brand !== 'claude' && s.brand !== 'cursor' && s.brand !== 'opencode') continue;
      if (seen.has(s.brand)) continue;

      const tail = stripAnsi(s.screenText).split('\n').slice(-5).join(' ');
      const pctMatch = tail.match(/(\d{1,3})%\s*(?:remaining|left|剩余)/i);
      const costMatch = tail.match(/\$([0-9]+\.[0-9]{2})/);
      if (pctMatch || costMatch) {
        seen.add(s.brand);
        const pct = pctMatch ? Math.min(100, Number(pctMatch[1])) : undefined;
        out.push({
          id: s.brand,
          brand: s.brand,
          name: getBrandLabel(s.brand),
          primary:
            pct !== undefined
              ? { label: '当前配额', remainingPct: pct, usedPct: 100 - pct }
              : undefined,
          badgeText: costMatch ? `$${costMatch[1]}` : undefined,
          lowQuota: pct !== undefined && pct <= 15,
          updatedAt: s.updatedAt,
          source: 'statusline',
        });
      }
    }

    return out;
  }

  private async collectCustomJsonQuotas(): Promise<ProviderQuota[]> {
    if (!fs.existsSync(this.customDir)) return [];
    const list: ProviderQuota[] = [];

    try {
      const files = await fsp.readdir(this.customDir);
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        try {
          const full = path.join(this.customDir, f);
          const raw = await fsp.readFile(full, 'utf8');
          const data = JSON.parse(raw) as Record<string, unknown>;
          const id = String(data.id ?? path.basename(f, '.json')).toLowerCase();
          const brand = (
            ['codex', 'devin', 'agy', 'claude', 'cursor', 'gemini', 'opencode'].includes(
              String(data.brand ?? id),
            )
              ? String(data.brand ?? id)
              : 'terminal'
          ) as AgentBrand;

          const primaryPct =
            typeof data.primaryRemainingPct === 'number'
              ? Math.max(0, Math.min(100, Math.round(data.primaryRemainingPct)))
              : undefined;
          const secondaryPct =
            typeof data.secondaryRemainingPct === 'number'
              ? Math.max(0, Math.min(100, Math.round(data.secondaryRemainingPct)))
              : undefined;

          list.push({
            id,
            brand,
            name: String(data.name ?? getBrandLabel(brand)),
            primary:
              primaryPct !== undefined
                ? {
                    label: String(data.primaryLabel ?? '5h 窗口'),
                    remainingPct: primaryPct,
                    usedPct: 100 - primaryPct,
                    resetText:
                      typeof data.resetText === 'string' ? data.resetText : undefined,
                  }
                : undefined,
            secondary:
              secondaryPct !== undefined
                ? {
                    label: String(data.secondaryLabel ?? '周额度'),
                    remainingPct: secondaryPct,
                    usedPct: 100 - secondaryPct,
                  }
                : undefined,
            badgeText: typeof data.badgeText === 'string' ? data.badgeText : undefined,
            subText: typeof data.subText === 'string' ? data.subText : undefined,
            lowQuota: primaryPct !== undefined && primaryPct <= 15,
            updatedAt: Date.now(),
            source: 'custom',
          });
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }

    return list;
  }

  private async loadCaches(): Promise<void> {
    try {
      const raw = await fsp.readFile(this.telemetryPath, 'utf8');
      const parsed = JSON.parse(raw) as DailyWorkTelemetry;
      if (parsed && parsed.date === this.todayKey()) {
        this.telemetry = {
          date: parsed.date,
          devinMs: parsed.devinMs ?? 0,
          agyMs: parsed.agyMs ?? 0,
          lastTickAt: Date.now(),
        };
      }
    } catch {
      // ignore
    }

    try {
      const rawAgy = await fsp.readFile(this.agyQuotaCachePath, 'utf8');
      this.agyCache = JSON.parse(rawAgy) as PersistedAgyQuotaCache;
    } catch {
      // ignore
    }

    try {
      const rawDevin = await fsp.readFile(this.devinQuotaCachePath, 'utf8');
      this.devinCache = JSON.parse(rawDevin) as PersistedDevinQuotaCache;
    } catch {
      // ignore
    }
  }

  private async saveTelemetry(): Promise<void> {
    try {
      await fsp.mkdir(path.dirname(this.telemetryPath), { recursive: true });
      await fsp.writeFile(this.telemetryPath, JSON.stringify(this.telemetry), 'utf8');
    } catch {
      // ignore
    }
  }

  private async saveAgyCache(): Promise<void> {
    if (!this.agyCache) return;
    try {
      await fsp.mkdir(path.dirname(this.agyQuotaCachePath), { recursive: true });
      await fsp.writeFile(this.agyQuotaCachePath, JSON.stringify(this.agyCache), 'utf8');
    } catch {
      // ignore
    }
  }

  private async saveDevinCache(): Promise<void> {
    if (!this.devinCache) return;
    try {
      await fsp.mkdir(path.dirname(this.devinQuotaCachePath), { recursive: true });
      await fsp.writeFile(this.devinQuotaCachePath, JSON.stringify(this.devinCache), 'utf8');
    } catch {
      // ignore
    }
  }
}
