import { AgentTask, IslandAlert, ProviderQuota } from '../src/types/monitor';

export function buildDemoSnapshot(baseTime = Date.now()): {
  tasks: AgentTask[];
  quotas: ProviderQuota[];
  alert: IslandAlert;
} {
  const tasks: AgentTask[] = [
    {
      id: 't4',
      name: 'payment-webhook',
      taskTitle: '重构 Stripe 异步回调幂等校验与单元测试',
      brand: 'codex',
      brandLabel: 'Codex',
      status: 'working',
      workspace: 'billing-service / 1',
      cwd: 'F:/Coding_Work/billing-service',
      startedAt: baseTime - (14 * 60 + 26) * 1000,
      statusChangedAt: baseTime - (14 * 60 + 26) * 1000,
      snippet: '已完成 Redis 分布式锁幂等层改造，正在执行并发回放回归测试。',
      fullMessage:
        '已完成 Redis 分布式锁幂等层改造，对重复投递的 Stripe event_id 返回 200 幂等响应，正在执行 18 组并发回放单元测试验证。',
      liveAction: 'cargo test webhook::idempotency_guard ... 18 passed',
      turn: 4,
    },
    {
      id: 't7',
      name: 'auth-audit',
      taskTitle: '确认数据库迁移脚本 004_session_idx.sql 执行权限',
      brand: 'agy',
      brandLabel: 'AGY',
      status: 'blocked',
      workspace: 'core-gateway / 2',
      cwd: 'F:/Coding_Work/core-gateway',
      startedAt: baseTime - (6 * 60 + 12) * 1000,
      statusChangedAt: baseTime - 95 * 1000,
      accumulatedMs: (4 * 60 + 37) * 1000,
      snippet: 'Allow command: psql -f migrations/004_session_idx.sql ? [y/n]',
      fullMessage:
        '索引创建语句已通过并发安全检查（CREATE INDEX CONCURRENTLY）。需要你确认是否立即在本地库执行该迁移：\nAllow command: psql -f migrations/004_session_idx.sql ? [y/n]',
      turn: 2,
    },
    {
      id: 't2',
      name: 'e2e-fix',
      taskTitle: '排查 Playwright 登录态偶发超时问题',
      brand: 'devin',
      brandLabel: 'Devin',
      status: 'working',
      workspace: 'web-console / 3',
      cwd: 'F:/Coding_Work/web-console',
      startedAt: baseTime - (29 * 60 + 5) * 1000,
      statusChangedAt: baseTime - (29 * 60 + 5) * 1000,
      snippet: '定位到 Cookie SameSite 属性在本地代理重定向时丢失，正在验证修复补丁。',
      fullMessage:
        '定位到根因：本地反向代理在 302 跳转时漏传了 Set-Cookie 的 SameSite=Lax 属性，导致并发 worker 偶发鉴权超时。正在重跑 20 轮压力验证。',
      liveAction: 'npx playwright test tests/auth.spec.ts --repeat-each=20',
      turn: 7,
    },
    {
      id: 't9',
      name: 'openapi-diff',
      taskTitle: '扫描 OpenAPI v3 契约变更并生成类型客户端',
      brand: 'claude',
      brandLabel: 'Claude Code',
      status: 'working',
      workspace: 'api-contracts / 1',
      cwd: 'F:/Coding_Work/api-contracts',
      startedAt: baseTime - (3 * 60 + 42) * 1000,
      statusChangedAt: baseTime - (3 * 60 + 42) * 1000,
      snippet: '已完成 12 个新增端点的 Zod Schema 生成，正在校对枚举字段兼容性。',
      fullMessage:
        '已完成 12 个新增端点的 TypeScript 类型与 Zod Schema 生成，未发现破坏性字段删除，正在做最终 tsc 全量编译校验。',
      liveAction: 'pnpm --filter @sdk/contracts typecheck',
      turn: 3,
    },
  ];

  const quotas: ProviderQuota[] = [
    {
      id: 'codex',
      brand: 'codex',
      name: 'Codex',
      primary: {
        label: '5h 窗口',
        remainingPct: 74,
        usedPct: 26,
        resetText: '2h 18m 后重置',
      },
      secondary: {
        label: '周额度',
        remainingPct: 61,
        usedPct: 39,
        resetText: '4d 6h 后重置',
      },
      subText: '2h 18m 后重置',
      lowQuota: false,
      updatedAt: baseTime,
      source: 'demo',
    },
    {
      id: 'agy',
      brand: 'agy',
      name: 'Antigravity',
      primary: {
        label: '5h 配额',
        remainingPct: 86,
        usedPct: 14,
        resetText: '3h 40m 后重置',
      },
      badgeText: '142 Credits',
      subText: 'Gemini 4 Carbon',
      lowQuota: false,
      updatedAt: baseTime,
      source: 'demo',
    },
    {
      id: 'devin',
      brand: 'devin',
      name: 'Devin',
      badgeText: '运行中 29m',
      subText: 'Claude Opus 5.5 High · 实时统计时长',
      lowQuota: false,
      updatedAt: baseTime,
      source: 'demo',
    },
  ];

  const alert: IslandAlert = {
    id: `demo-blocked-${baseTime}`,
    kind: 'blocked',
    brand: 'agy',
    brandLabel: 'AGY',
    title: '确认数据库迁移脚本 004_session_idx.sql 执行权限',
    subtitle: 'Allow command: psql -f migrations/004_session_idx.sql ? [y/n]',
    elapsedMs: (4 * 60 + 37) * 1000,
    timestamp: baseTime,
  };

  return { tasks, quotas, alert };
}
