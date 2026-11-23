export type AgentBrand =
  | 'codex'
  | 'devin'
  | 'agy'
  | 'claude'
  | 'cursor'
  | 'gemini'
  | 'opencode'
  | 'terminal';

export type TaskStatus = 'working' | 'blocked' | 'done' | 'error' | 'idle';

export interface AgentTask {
  id: string;
  name: string;
  taskTitle: string;
  brand: AgentBrand;
  brandLabel: string;
  status: TaskStatus;
  workspace: string;
  cwd: string;
  startedAt: number;
  statusChangedAt: number;
  accumulatedMs?: number;
  snippet: string;
  fullMessage: string;
  liveAction?: string;
  command?: string;
  turn?: number;
}

export interface QuotaWindow {
  label: string;
  remainingPct: number;
  usedPct: number;
  resetsAt?: number;
  resetText?: string;
}

export interface ProviderQuota {
  id: string;
  brand: AgentBrand;
  name: string;
  primary?: QuotaWindow;
  secondary?: QuotaWindow;
  badgeText?: string;
  subText?: string;
  lowQuota?: boolean;
  updatedAt: number;
  source: 'jsonl' | 'statusline' | 'api' | 'telemetry' | 'custom' | 'demo';
}

export interface IslandAlert {
  id: string;
  kind: 'blocked' | 'done' | 'error' | 'low_quota';
  brand: AgentBrand;
  brandLabel: string;
  title: string;
  subtitle: string;
  elapsedMs?: number;
  timestamp: number;
}

export interface MonitorSnapshot {
  connected: boolean;
  connectionHint?: string;
  hcPath?: string;
  demoMode: boolean;
  pinned: boolean;
  tasks: AgentTask[];
  quotas: ProviderQuota[];
  latestAlert: IslandAlert | null;
  updatedAt: number;
}
