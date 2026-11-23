import { AnimatePresence, motion } from 'framer-motion';
import {
  ChevronDown,
  ChevronUp,
  Clock,
  Eye,
  FolderGit2,
  Minimize2,
  Pin,
  RefreshCw,
  RotateCcw,
  Terminal,
} from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AgentTask,
  MonitorSnapshot,
  ProviderQuota,
  TaskStatus,
} from '../types/monitor';
import { formatElapsed } from '../utils/format';
import { BrandLogo } from './BrandLogo';

interface DynamicIslandProps {
  snapshot: MonitorSnapshot;
  now: number;
  onSnapshotUpdate: (next: MonitorSnapshot) => void;
}

function getTaskElapsedMs(task: AgentTask, now: number): number {
  if (task.status === 'working') {
    return Math.max(0, now - task.startedAt);
  }
  if (typeof task.accumulatedMs === 'number' && task.accumulatedMs > 0) {
    return task.accumulatedMs;
  }
  return Math.max(0, task.statusChangedAt - task.startedAt);
}

function statusMeta(status: TaskStatus): {
  label: string;
  dotClass: string;
  badgeClass: string;
  timerClass: string;
  cardBorderClass: string;
} {
  switch (status) {
    case 'working':
      return {
        label: '运行中',
        dotClass: 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.85)] animate-pulse',
        badgeClass: 'bg-emerald-500/15 text-emerald-300 border-emerald-400/28',
        timerClass: 'text-emerald-300',
        cardBorderClass: 'ring-1 ring-emerald-400/18',
      };
    case 'blocked':
      return {
        label: '待确认',
        dotClass: 'bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.9)] animate-ping',
        badgeClass: 'bg-amber-500/18 text-amber-300 border-amber-400/35',
        timerClass: 'text-amber-300',
        cardBorderClass: 'island-surface-blocked',
      };
    case 'error':
      return {
        label: '异常',
        dotClass: 'bg-rose-400 shadow-[0_0_8px_rgba(251,113,133,0.85)]',
        badgeClass: 'bg-rose-500/16 text-rose-300 border-rose-400/30',
        timerClass: 'text-rose-300',
        cardBorderClass: 'ring-1 ring-rose-400/28',
      };
    case 'done':
      return {
        label: '已完成',
        dotClass: 'bg-sky-400',
        badgeClass: 'bg-sky-500/12 text-sky-300 border-sky-400/22',
        timerClass: 'text-zinc-400',
        cardBorderClass: '',
      };
    default:
      return {
        label: '空闲',
        dotClass: 'bg-zinc-500',
        badgeClass: 'bg-white/[0.05] text-zinc-400 border-white/[0.08]',
        timerClass: 'text-zinc-500',
        cardBorderClass: '',
      };
  }
}

function quotaBarColor(pct: number): string {
  if (pct <= 15) return 'bg-rose-400';
  if (pct <= 32) return 'bg-amber-400';
  return 'bg-emerald-400';
}

function summarizeQuotaPill(q: ProviderQuota): { text: string; warn: 'low' | 'mid' | 'ok' } {
  if (q.primary) {
    const pct = q.primary.remainingPct;
    const warn = pct <= 15 ? 'low' : pct <= 32 ? 'mid' : 'ok';
    return { text: `${pct}%`, warn };
  }
  if (q.secondary) {
    const pct = q.secondary.remainingPct;
    const warn = pct <= 15 ? 'low' : pct <= 32 ? 'mid' : 'ok';
    return { text: `${pct}%`, warn };
  }
  return { text: q.badgeText ?? '在线', warn: q.lowQuota ? 'low' : 'ok' };
}

export function DynamicIsland({ snapshot, now, onSnapshotUpdate }: DynamicIslandProps) {
  const [hovered, setHovered] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [quotaExpanded, setQuotaExpanded] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const expandTimerRef = useRef<number | null>(null);
  const collapseTimerRef = useRef<number | null>(null);
  const frozenExpandedRef = useRef<boolean>(false);
  const dragSessionRef = useRef<{
    active: boolean;
    moved: boolean;
    startScreenX: number;
    startScreenY: number;
  }>({
    active: false,
    moved: false,
    startScreenX: 0,
    startScreenY: 0,
  });

  /**
   * TRUE DYNAMIC ISLAND BEHAVIOR:
   * - Default (mouse away & not pinned): Collapses into sleek compact Dynamic Island capsule!
   * - Hover (or Pin active): Smoothly expands into standalone Running Task Cards (max ~3 tall, wheel-scrollable, no scrollbar) + Quota panel!
   * - While dragging: Locks current view mode so nothing unmounts mid-drag!
   */
  const rawExpanded = hovered || snapshot.pinned;
  const isExpanded = dragging ? frozenExpandedRef.current : rawExpanded;

  const clearHoverTimers = useCallback(() => {
    if (expandTimerRef.current) {
      window.clearTimeout(expandTimerRef.current);
      expandTimerRef.current = null;
    }
    if (collapseTimerRef.current) {
      window.clearTimeout(collapseTimerRef.current);
      collapseTimerRef.current = null;
    }
  }, []);

  const finishDrag = useCallback(() => {
    if (!dragSessionRef.current.active) return;
    dragSessionRef.current.active = false;
    window.herdrIsland?.endDrag();
    setDragging(false);
  }, []);

  useEffect(() => {
    const onGlobalUp = () => {
      if (dragSessionRef.current.active) {
        finishDrag();
      }
    };
    window.addEventListener('pointerup', onGlobalUp, true);
    window.addEventListener('mouseup', onGlobalUp, true);
    window.addEventListener('pointercancel', onGlobalUp, true);
    return () => {
      window.removeEventListener('pointerup', onGlobalUp, true);
      window.removeEventListener('mouseup', onGlobalUp, true);
      window.removeEventListener('pointercancel', onGlobalUp, true);
    };
  }, [finishDrag]);

  const handleMouseEnter = () => {
    if (dragSessionRef.current.active) return;
    if (collapseTimerRef.current) {
      window.clearTimeout(collapseTimerRef.current);
      collapseTimerRef.current = null;
    }
    window.herdrIsland?.setInteractive(true);
    if (!hovered && !expandTimerRef.current) {
      expandTimerRef.current = window.setTimeout(() => {
        expandTimerRef.current = null;
        if (!dragSessionRef.current.active) {
          setHovered(true);
        }
      }, 180);
    }
  };

  const handleMouseLeave = () => {
    if (dragSessionRef.current.active) return;
    if (expandTimerRef.current) {
      window.clearTimeout(expandTimerRef.current);
      expandTimerRef.current = null;
    }
    collapseTimerRef.current = window.setTimeout(() => {
      if (dragSessionRef.current.active) return;
      setHovered(false);
      if (!snapshot.pinned) {
        window.herdrIsland?.setInteractive(false);
      }
    }, 180);
  };

  useEffect(() => {
    if (snapshot.pinned || dragging || hovered) {
      window.herdrIsland?.setInteractive(true);
    } else {
      window.herdrIsland?.setInteractive(false);
    }
  }, [snapshot.pinned, hovered, dragging]);

  useEffect(() => {
    const onDocLeave = () => {
      if (!snapshot.pinned && !dragSessionRef.current.active) {
        clearHoverTimers();
        setHovered(false);
        window.herdrIsland?.setInteractive(false);
      }
    };
    document.documentElement.addEventListener('mouseleave', onDocLeave);
    return () => {
      document.documentElement.removeEventListener('mouseleave', onDocLeave);
    };
  }, [snapshot.pinned, clearHoverTimers]);

  const handleDragStart = (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button')) return;

    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }

    clearHoverTimers();
    frozenExpandedRef.current = rawExpanded;
    dragSessionRef.current = {
      active: true,
      moved: false,
      startScreenX: e.screenX,
      startScreenY: e.screenY,
    };
    setDragging(true);
    window.herdrIsland?.setInteractive(true);
    window.herdrIsland?.startDrag();
  };

  const handleDragMoveCheck = (e: React.PointerEvent<HTMLElement>) => {
    if (!dragSessionRef.current.active) return;
    const dist = Math.hypot(
      e.screenX - dragSessionRef.current.startScreenX,
      e.screenY - dragSessionRef.current.startScreenY,
    );
    if (dist >= 4) {
      dragSessionRef.current.moved = true;
    }
  };

  const handleContainerMouseMove = (e: React.MouseEvent<HTMLElement>) => {
    if (dragSessionRef.current.active && (e.buttons & 1) === 0) {
      finishDrag();
      return;
    }
    if (!dragSessionRef.current.active) {
      window.herdrIsland?.setInteractive(true);
    }
  };

  // ONLY actively running / blocked / error tasks
  const activeTasks = useMemo(
    () =>
      snapshot.tasks.filter(
        (t) => t.status === 'working' || t.status === 'blocked' || t.status === 'error',
      ),
    [snapshot.tasks],
  );

  const headlineTask = useMemo(
    () =>
      activeTasks.find((t) => t.status === 'blocked') ??
      activeTasks.find((t) => t.status === 'working') ??
      activeTasks.find((t) => t.status === 'error'),
    [activeTasks],
  );

  // Deduplicate brand pills in collapsed capsule (e.g. show primary AGY Gemini + Codex)
  const pillQuotas = useMemo(() => {
    const seenBrands = new Set<string>();
    const list: ProviderQuota[] = [];
    for (const q of snapshot.quotas) {
      if (seenBrands.has(q.brand)) continue;
      if (q.primary || q.secondary) {
        seenBrands.add(q.brand);
        list.push(q);
      }
    }
    return list;
  }, [snapshot.quotas]);

  const handleToggleDemo = async () => {
    if (!window.herdrIsland) return;
    const next = await window.herdrIsland.toggleDemoMode();
    onSnapshotUpdate(next);
  };

  const handleTogglePin = async () => {
    if (!window.herdrIsland) return;
    const next = await window.herdrIsland.togglePin();
    onSnapshotUpdate(next);
  };

  const handleCollapseNow = async () => {
    clearHoverTimers();
    setHovered(false);
    if (snapshot.pinned && window.herdrIsland) {
      const next = await window.herdrIsland.togglePin();
      onSnapshotUpdate(next);
    }
    window.herdrIsland?.setInteractive(false);
  };

  const handleRefresh = async () => {
    if (!window.herdrIsland || refreshing) return;
    setRefreshing(true);
    try {
      const next = await window.herdrIsland.refreshNow();
      onSnapshotUpdate(next);
    } finally {
      window.setTimeout(() => setRefreshing(false), 350);
    }
  };

  const handleResetPosition = () => {
    window.herdrIsland?.resetPosition();
  };

  return (
    <div
      onMouseEnter={handleMouseEnter}
      onMouseMove={handleContainerMouseMove}
      onMouseLeave={handleMouseLeave}
      className="pointer-events-auto inline-flex flex-col items-center gap-2 max-w-[448px]"
    >
      <AnimatePresence mode="wait" initial={false}>
        {!isExpanded ? (
          /* ===================================================================
             STATE 1: COLLAPSED DYNAMIC ISLAND CAPSULE (Default sleek pill!)
             =================================================================== */
          <motion.div
            key="collapsed-island"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.14 }}
            onPointerDown={handleDragStart}
            onPointerMove={handleDragMoveCheck}
            className={`island-surface rounded-full h-[36px] pl-2.5 pr-3.5 flex items-center gap-2.5 cursor-grab active:cursor-grabbing ${
              activeTasks.some((t) => t.status === 'blocked') ? 'island-surface-blocked' : ''
            }`}
          >
            {headlineTask ? (
              <>
                <div className="flex items-center -space-x-1.5 shrink-0">
                  {activeTasks.slice(0, 3).map((t) => (
                    <div
                      key={t.id}
                      className="relative rounded-full ring-2 ring-[#0B0C0F]"
                    >
                      <BrandLogo brand={t.brand} size={22} />
                    </div>
                  ))}
                </div>

                <span
                  className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                    statusMeta(headlineTask.status).dotClass
                  }`}
                />

                <span className="text-[12.5px] font-medium text-zinc-100 truncate max-w-[148px] tracking-tight">
                  {headlineTask.taskTitle}
                </span>

                {activeTasks.length > 1 && (
                  <span className="text-[10.5px] font-medium text-zinc-300 bg-white/[0.08] px-1.5 py-0.5 rounded-full tabular-nums shrink-0">
                    +{activeTasks.length - 1}
                  </span>
                )}

                <span
                  className={`text-[12px] font-mono tabular-nums font-medium shrink-0 ${
                    statusMeta(headlineTask.status).timerClass
                  }`}
                >
                  {formatElapsed(getTaskElapsedMs(headlineTask, now))}
                </span>
              </>
            ) : (
              <>
                <span
                  className={`w-2 h-2 rounded-full shrink-0 ${
                    snapshot.connected ? 'bg-emerald-400/90' : 'bg-zinc-500'
                  }`}
                />
                <span className="text-[12px] font-medium text-zinc-300 shrink-0">
                  {snapshot.connected ? 'Herdr 待命' : 'Herdr 待连接'}
                </span>
              </>
            )}

            {/* Live Codex & AGY Real Quota % right inside the collapsed pill */}
            {pillQuotas.length > 0 && (
              <>
                <div className="h-3.5 w-px bg-white/[0.10] shrink-0" />
                <div className="flex items-center gap-2 shrink-0">
                  {pillQuotas.map((q) => {
                    const s = summarizeQuotaPill(q);
                    const color =
                      s.warn === 'low'
                        ? 'text-rose-300'
                        : s.warn === 'mid'
                          ? 'text-amber-300'
                          : 'text-zinc-200';
                    return (
                      <div key={q.id} className="inline-flex items-center gap-1">
                        <BrandLogo brand={q.brand} size={13} bare />
                        <span className={`text-[11.5px] font-mono tabular-nums font-medium ${color}`}>
                          {s.text}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </motion.div>
        ) : (
          /* ===================================================================
             STATE 2: EXPANDED / PINNED VIEW
             - Top slim control capsule (Pin to keep open, or move mouse away / click minimize to collapse back to Dynamic Island!)
             - Standalone Running Task Cards ONLY (~3 high, wheel-scrollable, zero scrollbar)
             - Real Quota Cards (Codex + AGY + Devin)
             =================================================================== */
          <motion.div
            key="expanded-island"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.15 }}
            className="w-[448px] flex flex-col items-center gap-2"
          >
            {/* Top Slim Control Capsule (Draggable + Pin + Collapse back to Island) */}
            <div
              onPointerDown={handleDragStart}
              onPointerMove={handleDragMoveCheck}
              className="w-full island-surface rounded-full h-[34px] px-3 flex items-center justify-between gap-2 cursor-grab active:cursor-grabbing"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span
                  className={`w-2 h-2 rounded-full shrink-0 ${
                    snapshot.connected
                      ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.7)]'
                      : 'bg-zinc-500'
                  }`}
                />
                <span className="text-[12px] font-semibold text-zinc-200 truncate">
                  {activeTasks.length > 0
                    ? `${activeTasks.length} 个任务运行中`
                    : '当前无运行中任务'}
                </span>
                {snapshot.pinned && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-white/[0.09] text-zinc-300">
                    已固定
                  </span>
                )}
              </div>

              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  onClick={() => setQuotaExpanded((v) => !v)}
                  className="h-6 px-2 rounded-full text-[11px] text-zinc-300 hover:bg-white/[0.08] inline-flex items-center gap-1 transition-colors cursor-pointer"
                >
                  <span>额度</span>
                  {quotaExpanded ? (
                    <ChevronUp className="w-3 h-3 text-zinc-400" />
                  ) : (
                    <ChevronDown className="w-3 h-3 text-zinc-400" />
                  )}
                </button>

                <button
                  type="button"
                  onClick={handleToggleDemo}
                  className={`h-6 px-2 rounded-full text-[11px] inline-flex items-center gap-1 transition-colors cursor-pointer ${
                    snapshot.demoMode
                      ? 'bg-violet-500/25 text-violet-200'
                      : 'text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.08]'
                  }`}
                >
                  <Eye className="w-3 h-3" />
                  <span>预览</span>
                </button>

                <button
                  type="button"
                  onClick={handleResetPosition}
                  className="w-6 h-6 rounded-full flex items-center justify-center text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.08] transition-colors cursor-pointer"
                >
                  <RotateCcw className="w-3 h-3" />
                </button>

                <button
                  type="button"
                  onClick={handleRefresh}
                  className="w-6 h-6 rounded-full flex items-center justify-center text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.08] transition-colors cursor-pointer"
                >
                  <RefreshCw className={`w-3 h-3 ${refreshing ? 'animate-spin' : ''}`} />
                </button>

                <button
                  type="button"
                  onClick={handleTogglePin}
                  className={`w-6 h-6 rounded-full flex items-center justify-center transition-colors cursor-pointer ${
                    snapshot.pinned
                      ? 'bg-emerald-500/25 text-emerald-300 ring-1 ring-emerald-400/35'
                      : 'text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.08]'
                  }`}
                >
                  <Pin className="w-3 h-3" />
                </button>

                <button
                  type="button"
                  onClick={handleCollapseNow}
                  className="w-6 h-6 rounded-full flex items-center justify-center text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.08] transition-colors cursor-pointer"
                >
                  <Minimize2 className="w-3 h-3" />
                </button>
              </div>
            </div>

            {/* Standalone Running Task Cards ONLY (Max ~3 cards viewport height, wheel-scrollable, zero scrollbar) */}
            {activeTasks.length > 0 && (
              <div className="w-full max-h-[432px] overflow-y-auto no-scrollbar flex flex-col gap-2 py-0.5">
                {activeTasks.map((task) => (
                  <RunningTaskCard
                    key={task.id}
                    task={task}
                    now={now}
                    onPointerDown={handleDragStart}
                    onPointerMove={handleDragMoveCheck}
                  />
                ))}
              </div>
            )}

            {/* Real Multi-Provider Quotas Card (Codex + AGY + Devin) */}
            {quotaExpanded && snapshot.quotas.length > 0 && (
              <div
                onPointerDown={handleDragStart}
                onPointerMove={handleDragMoveCheck}
                className="w-full island-surface rounded-2xl p-3 grid grid-cols-1 gap-1.5 cursor-grab active:cursor-grabbing"
              >
                {snapshot.quotas.map((q) => (
                  <div
                    key={q.id}
                    className="rounded-xl bg-white/[0.035] border border-white/[0.06] px-3 py-2 flex flex-col gap-1.5"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <BrandLogo brand={q.brand} size={18} bare />
                        <span className="text-[12px] font-medium text-zinc-100 shrink-0">
                          {q.name}
                        </span>
                        {q.subText && (
                          <span className="text-[10.5px] text-zinc-400 truncate">
                            · {q.subText}
                          </span>
                        )}
                      </div>

                      {q.badgeText && (
                        <span className="text-[11px] font-mono tabular-nums font-medium px-1.5 py-0.5 rounded-md bg-white/[0.07] text-zinc-200 shrink-0">
                          {q.badgeText}
                        </span>
                      )}
                    </div>

                    {(q.primary || q.secondary) && (
                      <div
                        className={`grid gap-2.5 ${
                          q.primary && q.secondary ? 'grid-cols-2' : 'grid-cols-1'
                        }`}
                      >
                        {q.primary && (
                          <QuotaTrack
                            label={q.primary.label}
                            remainingPct={q.primary.remainingPct}
                          />
                        )}
                        {q.secondary && (
                          <QuotaTrack
                            label={q.secondary.label}
                            remainingPct={q.secondary.remainingPct}
                          />
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function RunningTaskCard({
  task,
  now,
  onPointerDown,
  onPointerMove,
}: {
  task: AgentTask;
  now: number;
  onPointerDown: (e: React.PointerEvent<HTMLElement>) => void;
  onPointerMove: (e: React.PointerEvent<HTMLElement>) => void;
}) {
  const meta = statusMeta(task.status);
  const elapsed = getTaskElapsedMs(task, now);
  const isBlocked = task.status === 'blocked';

  return (
    <div
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      className={`w-full island-surface rounded-2xl px-3.5 py-3 shrink-0 cursor-grab active:cursor-grabbing ${meta.cardBorderClass}`}
    >
      <div className="flex items-start gap-2.5">
        <div className="relative mt-0.5 shrink-0">
          <BrandLogo brand={task.brand} size={30} />
          <span
            className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full ring-2 ring-[#101115] ${meta.dotClass}`}
          />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[13.5px] font-semibold text-zinc-50 truncate tracking-tight">
              {task.taskTitle}
            </span>
            <span
              className={`text-[10.5px] font-medium px-1.5 py-0.5 rounded-md border shrink-0 ${meta.badgeClass}`}
            >
              {meta.label}
            </span>
          </div>

          <div className="flex items-center justify-between gap-2 mt-1">
            <div className="flex items-center gap-1.5 text-[11px] text-zinc-400 min-w-0 truncate">
              <span className="font-medium text-zinc-300 shrink-0">{task.brandLabel}</span>
              <span className="text-zinc-600">·</span>
              <span className="inline-flex items-center gap-1 truncate">
                <FolderGit2 className="w-3 h-3 text-zinc-500 shrink-0" />
                <span className="truncate">{task.workspace}</span>
              </span>
              <span className="text-zinc-600">·</span>
              <span className="font-mono text-[10.5px] text-zinc-500 shrink-0">
                {task.name === task.id ? task.id : `${task.name} (${task.id})`}
              </span>
            </div>

            <div
              className={`inline-flex items-center gap-1 text-[12px] font-mono tabular-nums font-semibold shrink-0 ${meta.timerClass}`}
            >
              <Clock className="w-3 h-3 opacity-80" />
              <span>{formatElapsed(elapsed)}</span>
            </div>
          </div>

          <div
            className={`text-[12px] leading-[1.52] whitespace-pre-wrap break-words max-h-[112px] overflow-y-auto no-scrollbar mt-2 ${
              isBlocked ? 'text-amber-100/95' : 'text-zinc-200/95'
            }`}
          >
            {task.fullMessage}
          </div>

          {task.liveAction && task.liveAction !== task.fullMessage && (
            <div className="mt-1.5 pt-1.5 border-t border-white/[0.06] flex items-center gap-1.5 text-[11px] font-mono text-zinc-400 truncate">
              <Terminal className="w-3 h-3 text-emerald-400/80 shrink-0" />
              <span className="truncate">{task.liveAction}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function QuotaTrack({ label, remainingPct }: { label: string; remainingPct: number }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-[10.5px]">
        <span className="text-zinc-400">{label}</span>
        <span
          className={`font-mono tabular-nums font-medium ${
            remainingPct <= 15
              ? 'text-rose-300'
              : remainingPct <= 32
                ? 'text-amber-300'
                : 'text-zinc-200'
          }`}
        >
          剩余 {remainingPct}%
        </span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-white/[0.08] overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${quotaBarColor(
            remainingPct,
          )}`}
          style={{ width: `${Math.max(2, Math.min(100, remainingPct))}%` }}
        />
      </div>
    </div>
  );
}
