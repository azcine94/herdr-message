import path from 'node:path';
import { AgentBrand, TaskStatus } from '../../src/types/monitor';

const ANSI_REGEX =
  // eslint-disable-next-line no-control-regex
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

const GENERIC_SHELL_TITLES = new Set([
  'windows powershell',
  'powershell',
  'powershell.exe',
  'pwsh',
  'pwsh.exe',
  'cmd',
  'cmd.exe',
  'command prompt',
  'bash',
  'zsh',
  'sh',
  'nu',
  'nu.exe',
  'wsl',
  'wsl.exe',
  'conhost',
  'terminal',
  'herdr',
]);

const BRAND_LABELS: Record<AgentBrand, string> = {
  codex: 'Codex',
  devin: 'Devin',
  agy: 'AGY',
  claude: 'Claude Code',
  cursor: 'Cursor',
  gemini: 'Gemini',
  opencode: 'OpenCode',
  terminal: 'Terminal',
};

export function stripAnsi(input: string): string {
  return input.replace(ANSI_REGEX, '').replace(/\r/g, '');
}

export function getBrandLabel(brand: AgentBrand): string {
  return BRAND_LABELS[brand] ?? 'Terminal';
}

function matchBrandText(text: string): AgentBrand | null {
  const lower = text.toLowerCase();
  if (/\bcodex\b|openai-codex|@openai\/codex/.test(lower)) return 'codex';
  if (/\bdevin\b|cognition/.test(lower)) return 'devin';
  if (/\bagy\b|antigravity|gemini-coder/.test(lower)) return 'agy';
  if (/\bclaude\b|anthropic/.test(lower)) return 'claude';
  if (/\bcursor-agent\b|\bcursor\b/.test(lower)) return 'cursor';
  if (/\bopencode\b/.test(lower)) return 'opencode';
  if (/\bgemini\b/.test(lower)) return 'gemini';
  return null;
}

export function detectAgentBrand(
  raw: Record<string, unknown>,
  screenText = '',
): { brand: AgentBrand; brandLabel: string } {
  const labels =
    raw.labels && typeof raw.labels === 'object'
      ? (raw.labels as Record<string, unknown>)
      : {};
  const foreground =
    raw.foreground && typeof raw.foreground === 'object'
      ? (raw.foreground as Record<string, unknown>)
      : {};
  const agentObj =
    raw.agent && typeof raw.agent === 'object'
      ? (raw.agent as Record<string, unknown>)
      : null;
  const statusObj =
    raw.status && typeof raw.status === 'object'
      ? (raw.status as Record<string, unknown>)
      : null;

  const highPriorityCandidates: unknown[] = [
    statusObj?.app,
    typeof raw.agent === 'string' ? raw.agent : agentObj?.name ?? agentObj?.kind,
    labels.agent,
    labels.provider,
    raw.template,
    foreground.name,
    foreground.program,
    foreground.command,
    Array.isArray(foreground.argv) ? foreground.argv.join(' ') : undefined,
    raw.program,
    raw.command,
    raw.cmd,
    Array.isArray(raw.argv) ? raw.argv.join(' ') : undefined,
    raw.name,
    foreground.title,
    raw.title,
  ];

  for (const item of highPriorityCandidates) {
    if (typeof item === 'string' && item.trim()) {
      const matched = matchBrandText(item);
      if (matched) {
        return { brand: matched, brandLabel: getBrandLabel(matched) };
      }
    }
  }

  if (screenText) {
    const clean = stripAnsi(screenText);
    const tail = clean.split('\n').slice(-18).join('\n');
    if (/AI Credits:\s*\d+/i.test(tail) || /Antigravity|Gemini \d/i.test(tail)) {
      return { brand: 'agy', brandLabel: getBrandLabel('agy') };
    }
    if (/five-hour-limit|weekly-limit|Ask Codex to do anything|\bcodex\b.*gpt-/i.test(tail)) {
      return { brand: 'codex', brandLabel: getBrandLabel('codex') };
    }
    if (/Guide Devin while it works|\bDevin\b.*\bACU\b|app\.devin\.ai/i.test(tail)) {
      return { brand: 'devin', brandLabel: getBrandLabel('devin') };
    }
    if (/Claude Code|claude-sonnet|claude-opus/i.test(tail)) {
      return { brand: 'claude', brandLabel: getBrandLabel('claude') };
    }
  }

  return { brand: 'terminal', brandLabel: getBrandLabel('terminal') };
}

export function normalizeStatus(raw: Record<string, unknown>): TaskStatus {
  const statusObj =
    raw.status && typeof raw.status === 'object'
      ? (raw.status as Record<string, unknown>)
      : null;
  const agentObj =
    raw.agent && typeof raw.agent === 'object'
      ? (raw.agent as Record<string, unknown>)
      : null;
  const observedObj =
    raw.observed && typeof raw.observed === 'object'
      ? (raw.observed as Record<string, unknown>)
      : null;

  const statusCandidate = String(
    (typeof raw.status === 'string' ? raw.status : statusObj?.state) ??
      raw.ls_status ??
      raw.agent_status ??
      agentObj?.status ??
      observedObj?.status ??
      '',
  )
    .trim()
    .toLowerCase();

  const stateCandidate = String(raw.state ?? '').trim().toLowerCase();

  if (
    statusCandidate === 'blocked' ||
    statusCandidate === 'needs_you' ||
    statusCandidate === 'needs you' ||
    statusCandidate === 'waiting_input' ||
    statusCandidate === 'approval'
  ) {
    return 'blocked';
  }
  if (statusCandidate === 'working' || statusCandidate === 'running' || statusCandidate === 'busy') {
    return 'working';
  }
  if (statusCandidate === 'error' || statusCandidate === 'failed') {
    return 'error';
  }
  if (statusCandidate === 'done' || statusCandidate === 'completed' || statusCandidate === 'finished') {
    return 'done';
  }
  if (stateCandidate === 'finished' || raw.exited === true) {
    const exitCode = typeof raw.exit_code === 'number' ? raw.exit_code : 0;
    return exitCode !== 0 ? 'error' : 'done';
  }
  return 'idle';
}

function cleanCandidateTitle(input: string, workspace?: string): string {
  let s = stripAnsi(input).trim();
  s = s.replace(/^(?:devin|codex|agy|antigravity|claude|cursor)(?:\.exe)?\s*[:：]\s*/i, '').trim();
  s = s.replace(/^[\u2800-\u28FF⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏✳✦●•◦▪▫⏳⚡*>\-\s]+/, '').trim();
  s = s.replace(
    /\s+(?:[-—|·])\s*(?:Claude Code|OpenAI Codex|Codex|Antigravity|AGY|Devin|Herdr)$/i,
    '',
  ).trim();
  if (workspace) {
    const baseWorkspace = workspace.split('/')[0].trim();
    if (baseWorkspace && s.endsWith(`| ${baseWorkspace}`)) {
      s = s.slice(0, -`| ${baseWorkspace}`.length).trim();
    }
  }
  return s;
}

function isGenericOrNoiseTitle(title: string): boolean {
  if (!title || title.length < 2) return true;
  const lower = title.toLowerCase().trim();
  if (GENERIC_SHELL_TITLES.has(lower)) return true;
  if (/^(?:administrator|管理员)\s*[:：]/i.test(lower)) return true;
  if (/^[a-z]:\\windows\\system32/i.test(lower)) return true;
  if (/^t\d+[a-z]?$/i.test(lower)) return true;
  return false;
}

function extractDevinDividerTitle(screenText: string): string | null {
  if (!screenText) return null;
  const lines = stripAnsi(screenText).split('\n').slice(-10);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/─{4,}\s+(.{2,80}?)\s+─+\s*$/);
    if (m && m[1].trim()) {
      return m[1].trim();
    }
  }
  return null;
}

function extractPromptFromScreen(screenText: string): string | null {
  if (!screenText) return null;
  const lines = stripAnsi(screenText)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const promptMatch = line.match(/^(?:›|❯|❭|>)\s+(.{2,100})$/);
    if (promptMatch) {
      const candidate = promptMatch[1].trim();
      if (
        !/^(?:type a message|ask anything|ask codex|guide devin|enter a prompt|press enter|\?|\/help|\/status|\/usage|\/quota|\/credits)/i.test(
          candidate,
        ) &&
        !/^PS\s+[A-Z]:\\/i.test(candidate)
      ) {
        return candidate;
      }
    }
  }
  return null;
}

export function extractWorkspaceName(
  cwd: string,
  rawWhere?: unknown,
  labels?: Record<string, unknown>,
): string {
  if (typeof rawWhere === 'string' && rawWhere.trim()) {
    return rawWhere.trim();
  }
  if (labels && typeof labels.where === 'string' && labels.where.trim()) {
    return labels.where.trim();
  }
  if (!cwd) return 'Local';
  const normalized = cwd.replace(/[\\/]+$/, '');
  const base = path.basename(normalized);
  return base || normalized;
}

export function extractTaskTitle(
  raw: Record<string, unknown>,
  workspace: string,
  brandLabel: string,
  screenText = '',
): string {
  const labels =
    raw.labels && typeof raw.labels === 'object'
      ? (raw.labels as Record<string, unknown>)
      : {};
  const foreground =
    raw.foreground && typeof raw.foreground === 'object'
      ? (raw.foreground as Record<string, unknown>)
      : {};
  const firstMsg =
    raw.first_message && typeof raw.first_message === 'object'
      ? (raw.first_message as Record<string, unknown>)
      : null;

  const devinFullTitle = extractDevinDividerTitle(screenText);
  if (devinFullTitle && !isGenericOrNoiseTitle(devinFullTitle)) {
    return devinFullTitle.slice(0, 72);
  }

  const explicitCandidates: unknown[] = [
    labels.task,
    labels.title,
    labels['review.summary'],
    labels.summary,
    raw.task,
    typeof raw.first_message === 'string' ? raw.first_message : firstMsg?.task ?? firstMsg?.text,
    foreground.title,
    raw.title,
    raw.window_title,
  ];

  for (const c of explicitCandidates) {
    if (typeof c === 'string' && c.trim()) {
      const cleaned = cleanCandidateTitle(c.split('\n')[0], workspace);
      if (!isGenericOrNoiseTitle(cleaned)) {
        return cleaned.slice(0, 72);
      }
    }
  }

  const screenPrompt = extractPromptFromScreen(screenText);
  if (screenPrompt) {
    return screenPrompt.slice(0, 72);
  }

  if (typeof raw.name === 'string' && raw.name.trim()) {
    const cleanedName = cleanCandidateTitle(raw.name, workspace);
    if (!isGenericOrNoiseTitle(cleanedName)) {
      return cleanedName;
    }
  }

  if (workspace && workspace !== 'Local') {
    return workspace.split('/')[0].trim() || workspace;
  }
  return `${brandLabel} 任务`;
}

function isPureNoiseOrTipLine(rawLine: string): boolean {
  const line = rawLine.trim();
  if (!line || line.length < 2) return true;
  // Box drawing / horizontal rules
  if (/^[\s─━═╭╮╰╯│┃┌┐└┘├┤┬┴┼▀▄█░▒▓\-_=·•*]+$/.test(line)) return true;
  // Empty prompts
  if (/^(?:›|❯|❭|>|\$|PS\s+[A-Z]:[^>]*>)\s*$/.test(line)) return true;
  // CLI Tips (`└ Tip: Use /archive...`, `Tip: Press f3...`, `✱ Did you know`, `See all keyboard shortcuts`)
  if (/^(?:[└├│╭╰]\s*)?Tip:\s+/i.test(line)) return true;
  if (/^(?:✱\s*Did you know|See all keyboard shortcuts)/i.test(line)) return true;
  // TUI bottom input placeholders & model footers
  if (
    /(?:\?\s*for shortcuts|← for agents|ctrl\+d to exit|ctrl\+o to expand|ctrl\+t to expand|esc to cancel|esc to interrupt|esc twice to interrupt|Guide Devin while it works|Ask Codex to do anything|alt\+v to paste|AI Credits:\s*\d+|GPT-[\d.]+.*\s·\s|Claude Opus.*bypass|auto\s*·\s*Gemini|\+\s*\d+\s*lines|\+\s*Show details)/i.test(
      line,
    )
  ) {
    return true;
  }
  // Devin bottom title divider
  if (/─{4,}\s+.+\s+─+\s*$/.test(line)) return true;
  return false;
}

function isToolOrSpinnerLine(line: string): boolean {
  const trimmed = line.trim();
  if (
    /^(?:[•●✓○▸]\s*)?(?:Ran\s+|Running\s+|Working\s*\(|Waiting for background terminal|Thought for\s+|Thinking\b|Explored\s+|Edited\s+|Viewed\s+|Read shell\s+|Reading shell\s+)/i.test(
      trimmed,
    )
  ) {
    return true;
  }
  if (/^[\u2800-\u28FF]+\s*(?:Running|Thinking|Waiting)/i.test(trimmed)) return true;
  if (/^[└├]\s+/.test(trimmed)) return true;
  if (/^(?:✓|●)\s+(?:python|mkdir|for\s+|ffmpeg|git|npm|node|powershell|cmd)\b/i.test(trimmed)) {
    return true;
  }
  if (/^Worked for\s+\d+/i.test(trimmed)) return true;
  return false;
}

/**
 * Extracts BOTH:
 * - `fullMessage`: The complete, untruncated natural-language message / summary from the agent's current or latest turn.
 * - `liveAction`: Optional compact 1-line tool/command step currently running right now.
 * - `snippet`: Short 1-line summary for compact toast notifications.
 */
export function extractTaskMessages(
  screenText: string,
  status: TaskStatus,
  statusMsg?: string,
): { fullMessage: string; liveAction?: string; snippet: string } {
  if (!screenText) {
    const fallback =
      statusMsg ||
      (status === 'working'
        ? '正在执行任务...'
        : status === 'blocked'
          ? '等待你的确认或输入'
          : status === 'done'
            ? '任务执行完成'
            : status === 'error'
              ? '任务执行异常'
              : '终端空闲待命');
    return { fullMessage: fallback, snippet: fallback };
  }

  const rawLines = stripAnsi(screenText).split('\n');

  // Filter noise while preserving paragraph boundaries (blank lines -> '')
  const cleanedLines: string[] = [];
  let skipDidYouKnowNext = false;
  for (const raw of rawLines) {
    const trimmed = raw.replace(/[│┃]/g, ' ').trim();
    if (skipDidYouKnowNext) {
      skipDidYouKnowNext = false;
      if (/shortcuts/i.test(trimmed)) continue;
    }
    if (/^✱\s*Did you know/i.test(trimmed)) {
      skipDidYouKnowNext = true;
      continue;
    }
    if (!trimmed) {
      if (cleanedLines.length > 0 && cleanedLines[cleanedLines.length - 1] !== '') {
        cleanedLines.push('');
      }
      continue;
    }
    if (isPureNoiseOrTipLine(trimmed)) continue;
    cleanedLines.push(trimmed);
  }

  // Trim trailing empty lines
  while (cleanedLines.length > 0 && cleanedLines[cleanedLines.length - 1] === '') {
    cleanedLines.pop();
  }

  if (cleanedLines.length === 0) {
    const fallback = statusMsg || (status === 'working' ? '正在运行中...' : '待命中');
    return { fullMessage: fallback, snippet: fallback };
  }

  // Find last user prompt (`› ...`, `❭ ...`, `> ...`) so we focus on the current turn
  let lastPromptIdx = -1;
  for (let i = cleanedLines.length - 1; i >= 0; i--) {
    const l = cleanedLines[i];
    if (
      /^(?:›|❯|❭|>)\s+.{2,}/.test(l) &&
      !/^(?:›|❯|❭|>)\s*(?:Ask Codex|Guide Devin)/i.test(l)
    ) {
      lastPromptIdx = i;
      break;
    }
  }

  const turnLines =
    lastPromptIdx >= 0 && lastPromptIdx < cleanedLines.length - 1
      ? cleanedLines.slice(lastPromptIdx + 1)
      : cleanedLines.slice(-28);

  // If blocked, surface the exact confirmation prompt / question in full
  if (status === 'blocked') {
    const nonEmpty = turnLines.filter(Boolean);
    for (let i = nonEmpty.length - 1; i >= 0; i--) {
      if (/(?:\[y\/n\]|allow|approve|permission|confirm|确认|允许|是否|选择|\?)/i.test(nonEmpty[i])) {
        const blockContext = nonEmpty.slice(Math.max(0, i - 2), i + 1).join('\n');
        return {
          fullMessage: blockContext,
          snippet: nonEmpty[i].slice(0, 120),
        };
      }
    }
  }

  // Group `turnLines` into contiguous paragraphs separated by ''
  const paragraphs: string[][] = [];
  let currentPara: string[] = [];
  for (const l of turnLines) {
    if (l === '') {
      if (currentPara.length > 0) {
        paragraphs.push(currentPara);
        currentPara = [];
      }
    } else {
      currentPara.push(l);
    }
  }
  if (currentPara.length > 0) paragraphs.push(currentPara);

  // Separate natural-language prose paragraphs from tool/command log lines
  let latestProseParagraph: string | null = null;
  let latestToolLine: string | null = null;

  for (let pIdx = paragraphs.length - 1; pIdx >= 0; pIdx--) {
    const para = paragraphs[pIdx];
    const proseLines: string[] = [];

    for (const line of para) {
      if (isToolOrSpinnerLine(line)) {
        if (!latestToolLine) {
          latestToolLine = line
            .replace(/^[\u2800-\u28FF\s•●✓▸○└├]+/, '')
            .replace(/\s+/g, ' ')
            .trim();
        }
      } else {
        proseLines.push(line.replace(/^[•●]\s+/, '').trim());
      }
    }

    if (!latestProseParagraph && proseLines.length > 0) {
      latestProseParagraph = proseLines.join('\n').trim();
    }
  }

  if (latestProseParagraph) {
    return {
      fullMessage: latestProseParagraph.slice(0, 420),
      liveAction:
        status === 'working' && latestToolLine ? latestToolLine.slice(0, 110) : undefined,
      snippet: (latestProseParagraph.split('\n')[0] || latestProseParagraph).slice(0, 110),
    };
  }

  // Fallback if screen only has tool/shell output lines
  const recentNonEmpty = turnLines
    .filter(Boolean)
    .slice(-3)
    .map((l) => l.replace(/^[\u2800-\u28FF\s•●✓▸○]+/, '').trim());
  const joined = recentNonEmpty.join('\n') || statusMsg || '正在运行中...';
  return {
    fullMessage: joined.slice(0, 360),
    snippet: (recentNonEmpty[recentNonEmpty.length - 1] || joined).slice(0, 110),
  };
}

export function extractScreenSnippet(
  screenText: string,
  status: TaskStatus,
  statusMsg?: string,
): string {
  return extractTaskMessages(screenText, status, statusMsg).snippet;
}
