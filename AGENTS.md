# AGENTS.md — Herdr Island (Windows 灵动岛 Agent 只读监控端)

本项目是一个运行在 Windows 桌面顶部的 **灵动岛（Dynamic Island）风格只读监控小程序**，用于实时观测本机 **Herdr (`herdr-core` / `hc.exe`)** 中运行的各家 AI Coding Agent（**Codex**、**Devin**、**AGY / Google Antigravity**，以及后续扩展的 **Claude Code**、**Cursor**、**OpenCode** 等）的任务状态、任务标题、运行时长与账号额度。

任何参与本项目开发或维护的 Agent 必须严格遵守以下红线与设计准则。

---

## 1. 绝对红线：100% 物理级只读与零侵入（NON-NEGOTIABLE）

1. **严禁修改 Herdr 的任何文件、配置或窗口状态**
   - **禁止**写入、修改或删除 `~/.config/herdr-core/`、`~/.config/herdr-app/`、`%APPDATA%\herdr-core\`、`%LOCALAPPDATA%\Programs\herdr-core\` 下的任何内容。
   - **禁止**安装任何 Herdr 插件、修改 Herdr 布局或主动抢占/缩放/移动 Herdr 桌面窗口。
2. **`hc.exe` 命令白名单制度（仅允许以下 4 类只读调用）**
   - `hc ls --json`：读取存活终端列表快照。
   - `hc get <terminal> --json`：读取单个终端的元数据（目录、标题、标签、状态）。
   - `hc events --json`：流式订阅终端事实与状态变更（NDJSON）。
   - `hc read --lines 0 <terminal>`：仅读取当前可见屏幕缓冲区（**必须固定携带 `--lines 0`**，严禁省略或传入大于 0 的行数，防止触发全屏 TUI 历史滚动）。
   - **严禁在代码中封装或调用**：`run`、`send`、`keys`、`interrupt`、`kill`、`rm`、`label`、`keep`、`put`、`exec`、`file write/edit`、`server stop/restart`、`update`。
3. **本地日志与配置只读访问**
   - 读取 `~/.codex/sessions/**/*.jsonl`、`~/.gemini/antigravity-cli/settings.json` 等第三方路径时，只能使用只读文件操作（`fs.promises.readFile` / `createReadStream`），绝不写入或锁定原文件。
   - 本程序自身的配置与状态缓存仅允许存放在 Electron 独立 `userData` 目录或 `~/.herdr-island/` 下。

---

## 2. 核心信息展示要求

用户抬眼看向灵动岛或悬停展开时，必须一眼看清以下核心要素：

1. **品牌 Logo 精准识别（`BrandLogo`）**
   - 多维特征识别优先级：`hc` 原生 `agent` 字段 > 启动命令/进程名 (`command`/`argv`) > 标签 (`labels.agent`) > 终端标题/屏幕特征。
   - 必须使用精准的官方矢量几何图标（SVG），严禁使用简陋字母占位符代替已知品牌：
     - **Codex**（OpenAI 六瓣花矢量标）
     - **Devin**（Cognition / Devin 官方几何节点矢量标）
     - **AGY**（Google Antigravity 官方悬浮弧线矢量标）
     - **Claude Code**（Anthropic / Claude 星芒矢量标）
     - **Cursor** / **Gemini** / **OpenCode** / **Terminal（通用终端兜底）**
2. **哪个任务在跑 & 具体叫什么名字**
   - **任务标题 (`taskTitle`)**：优先提取有意义的终端动态标题（过滤掉 `pwsh`、`cmd.exe` 等无意义壳名）、`labels.task`、启动任务描述或屏幕内最近一条用户指令（如 `› ...`），兜底使用「项目目录名 + 终端名」。
   - **定位上下文 (`workspace` & `terminalId`)**：清晰展示所在项目文件夹名（`cwd` basename）与 Herdr 终端标识（如 `t3` / 自定义 `name`）。
   - **最新动态摘要 (`snippet`)**：清洗掉 TUI 边框线后的最后一行有效输出；在 `blocked`（待确认/提问）状态下高亮展示阻塞原因。
3. **任务运行时间 (`elapsedMs`)**
   - `working` 状态下以等宽数字（`tabular-nums`）每秒实时跳动显示已运行时长（如 `08:42`、`1h 12m`）。
   - 记录任务进入 `working` 的精确起始点（优先采用 `hc` 返回的时间戳，辅以状态转换计时与本地缓存持久化，避免重启小程序归零）。
4. **多源额度监控 (`QuotaProvider` 插件架构)**
   - **Codex**：只读解析 `~/.codex/sessions/` 最新会话 `.jsonl` 中的 `rate_limits`（5h 滚动窗口与周限额剩余百分比、重置倒计时），并以终端 `/statusline` 文本作为兜底。
   - **AGY**：只读提取 Herdr 内 `agy` 终端底栏 `AI Credits` 与 `/usage` 可见额度信息。
   - **Devin**：统计本机 Herdr 内 Devin 活跃任务数与今日累计运行时长；支持可选配置官方只读 API Key 拉取剩余 ACU。
   - **可扩展协议**：监听 `~/.herdr-island/quotas/*.json`，任何新增 Agent 按统一 JSON Schema 输出额度文件即可自动渲染品牌图标与进度条。

---

## 3. 视觉审美与交互规范

- **设计语言**：克制、干净、利落。采用深曜石黑磨砂胶囊（`#09090B`）+ `1px` 微光内描边（`rgba(255,255,255,0.09)`），杜绝廉价霓虹渐变、杂乱边框与多余装饰。
- **字体与排版**：所有计时器、百分比、配额数字一律强制启用 `font-variant-numeric: tabular-nums`，确保数字跳动时宽度绝对稳定、零抖动。
- **三态流体过渡**：
  1. **紧凑胶囊态（常驻顶栏居中）**：直接展示「活跃 Agent 品牌图标 + 当前主任务标题 + 实时计时 + 最低剩余额度预警」。
  2. **灵动通知态（自动弹出 4.5s）**：当任务进入 `blocked`（待确认）、`done`（已完成）或 `error` 时平滑展开摘要卡片。
  3. **悬停看板态（鼠标移入展开）**：完整展示活跃任务列表与各家额度进度条。
- **智能鼠标穿透**：窗口透明画布区域必须开启 `setIgnoreMouseEvents(true, { forward: true })`，保证胶囊外部区域 100% 不遮挡浏览器标签栏或编辑器顶栏点击，鼠标移入胶囊实体时无缝接管交互。

---

## 4. 目录结构约定

```text
herdr-island/
├── AGENTS.md                 # Agent 架构红线与审美规范（本文件）
├── package.json              # 项目依赖与启动脚本
├── electron/
│   ├── main.ts               # Electron 主进程（置顶无边框窗口、120Hz 拖拽、智能鼠标穿透、系统托盘）
│   ├── preload.ts            # 安全只读 IPC 桥接
│   ├── herdr/
│   │   ├── agentDetector.ts  # Agent 品牌识别与完整消息清洗提取
│   │   └── herdrMonitor.ts   # hc.exe 纯只读监控器（ls / get / events / read --lines 0）
│   └── quota/
│       ├── devinUsageProbe.py  # Devin CLI /usage 无窗口伪终端探针
│       ├── devinUsageProbe.ps1 # 免 Python 环境的 PowerShell 原生伪终端探针兜底
│       └── quotaManager.ts     # 插件化只读额度采集器（Codex / AGY / Devin / JSON 扩展）
└── src/
    ├── types/                # 前后端共享类型定义
    ├── components/
    │   ├── BrandLogo.tsx     # 各家 Agent 官方矢量品牌图标组件
    │   └── DynamicIsland.tsx # 灵动岛胶囊与运行任务卡视图
    ├── App.tsx
    └── main.tsx
```
