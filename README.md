# Herdr Island · Windows 灵动岛 Agent 状态与额度只读监控

专为 **Herdr (`herdr-core` / `hc.exe`)** 打造的 Windows 桌面灵动岛悬浮监控工具。  
**100% 物理级只读**，零侵入、不修改任何 Herdr 配置或终端状态，实时监控本机 **Codex**、**Devin**、**AGY (Google Antigravity)**、**Claude Code**、**Cursor** 等 Agent 的运行任务、完整最新消息、实时耗时与真实账号额度。

---

## 核心特性

- **灵动岛收放自如 + 120Hz 任意拖拽**：
  - 平时自动收起成精致小胶囊（直接展示当前运行任务、实时计时与各家剩余额度百分比）。
  - 鼠标移入自动展开为独立的**正在运行任务卡片**（完整多行消息展示、超过 3 张支持无滚动条鼠标滚轮滑动）；点击 **📌 图钉** 可常驻固定在桌面任意角落。
  - 周围透明画布 100% 鼠标穿透，绝不遮挡浏览器顶部标签页或编辑器点击。
- **官方品牌矢量图标自动识别**：支持 **Codex**、**Devin**、**AGY (Google Antigravity)**、**Claude Code**、**Cursor**、**Gemini**、**OpenCode**。
- **三家真实额度自动刷新**：
  - **Codex**：每 15 秒实时解析本机 `~/.codex/sessions/` 最新事件时间戳下的 `rate_limits`（支持超大单轮日志多块回溯）。
  - **AGY**：每 2 分钟（及每次 AGY 任务结束时）通过官方 `agy -p "/usage"` 静默同步 Gemini 与 Claude/GPT 双池 5h / 周剩余额度。
  - **Devin**：每 2.5 分钟（及每次 Devin 任务结束时）通过无窗口伪终端 `/usage` 探针（自动兼容 Python 或 Windows 内置 PowerShell，零额外依赖）同步剩余额度百分比。
  - 点击右上角 **`↻` 刷新按钮** 可随时破除冷却立即强制重拉全部额度。
- **100% 隐私安全与纯本地运行**：
  - 仓库内**不包含任何个人账号、路径或凭证**；运行时不在项目目录写入任何缓存（运行期缓存仅存于系统本机 `%APPDATA%\herdr-island`），无任何外部遥测或数据上传。

---

## 环境要求与快速上手

### 前置条件
1. **Windows 10 / 11**（已内置 ConPTY 伪终端与 PowerShell）
2. **Node.js 18+**
3. 已安装并使用 **[Herdr](https://herdr.dev)** 桌面端（含 `hc.exe`）

### 安装与启动
```powershell
# 1. 安装依赖（首次拉取代码后执行一次）
npm install

# 2. 编译构建
npm run build
```

日常使用直接双击根目录下的 **`启动灵动岛.bat`**（或无窗口静默版 **`静默启动灵动岛.vbs`**）即可启动。  
右下角系统托盘也会常驻胶囊图标，右键可切换显示器、重置位置、开启演示预览或退出。

---

## 扩展自定义 Agent 额度

如需接入其他工具的自定义额度，只需往本机 `~/.herdr-island/quotas/<name>.json` 写入 JSON 文件，灵动岛会自动识别渲染：

```json
{
  "brand": "claude",
  "name": "Claude Code",
  "primaryLabel": "5h 窗口",
  "primaryRemainingPct": 82,
  "secondaryLabel": "周额度",
  "secondaryRemainingPct": 65,
  "resetText": "1h 40m 后重置"
}
```

---

## License

MIT License
