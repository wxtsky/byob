# Changelog (中文)

[English](CHANGELOG.md) · **中文**

> 完整英文版以 [CHANGELOG.md](CHANGELOG.md) 为准。中文版主要给中文圈快速浏览。

---

## [0.1.0] — 2026-04-25

### 旗舰功能

- **10 个 MCP 工具** 端到端跑通：`browser_read`、`browser_screenshot`、`browser_click`、`browser_type`、`browser_get_cookies`、`browser_navigate`、`browser_wait_for`、`browser_list_tabs`、`browser_switch_tab`、`browser_eval`。
- **Native Messaging 全链路** —— bun-workspaces TS monorepo，3 个包（`@byob/shared` schemas、`@byob/bridge` Native Messaging host、`@byob/mcp-server` stdio MCP server）+ WXT 构建的 MV3 扩展。
- **每用户独立 RSA key** —— `byob install` 首次跑会自动生成 `~/.byob/extension-key.pem`；`wxt.config.ts` 动态读它。两台机器装 byob 得到两个不同的扩展 ID。
- **一条命令安装** —— `byob install` 全自动：生成 key → build 扩展 → 写 NM manifest → 打印下一步。
- **多 bridge 支持** —— 每个 Chrome profile 一个 `byob-bridge` 进程，全在 `~/.byob/bridges.json` 里登记 + PID 探活。
- **管理 CLI** —— `byob doctor / install / bridges / logs / uninstall`。

### 可靠性

- **CDP attach 3 次重试** + 线性 backoff（解 DevTools 切换的 race）。
- **discarded tab 复活** —— Chrome 因内存压力 GC 了后台 tab 时，attach 前自动 reload + waitForLoad。
- **特殊 URL 预检** —— 在 CDP attach 之前抓住 `chrome://` / `devtools://` / `about://` active tab，报为 `url_forbidden` + 可操作 hint，不再是模糊的 `cdp_attach_failed`。
- **`chrome.power.requestKeepAwake('display')`** 用 refcounted helper 包裹长操作，并发调用不打架。
- **beforeunload 守卫** —— `browser_read` 期间安装，防 SPA 自发跳转把 DOM 抽走。
- **SPA priming + scrollHeight 稳定检测** —— 首屏 prime + 跟踪 scrollHeight 稳定性，修了"X.com / FB / 新版 Reddit 第 1 轮抓零 chunks"的失败。
- **bridgePost / bridgeGet timeout** —— undici Agent 显式 10 分钟上限 + bridge 不可达时干净的 `bridge_not_running` envelope。
- **NM 协议 envelope 剥离** —— bridge 不再泄漏 `type` / `requestId` 到 HTTP 响应。
- **Handler `type` 字段冲突修复** —— dispatcher 现在先 spread payload 再写 NM 协议字段，handler 永远不能 shadow `type:'result'`（`EvalOutput.type` 撞过这事，整个 pending-request map 失灵）。
- **Cookie sameSite 枚举** 现在匹配 Chrome `chrome.cookies` API 的小写格式，不再混用 CDP `Network.getCookies` 的大写。
- **focused-window tab 放置** —— 新后台 tab 出现在用户当前看的窗口里，不会冒到别的窗口去。

### 安全

- **`browser_eval` 默认隐藏**。MCP server env 里设 `BYOB_ALLOW_EVAL=1` 才暴露给 LLM。
- **URL 黑名单** —— `chrome:`/`chrome-extension:`/`about:`/`devtools:`/`view-source:`/`file:` 协议 + 主要认证域名默认拒绝。
- **eval 审计日志** —— 每次调用都 append 到 `~/.byob/eval-audit.log`。
- **eval 限速** —— 每个 tab 5 次/分钟（扩展端）。
- **eval Chrome 通知** —— 每次调用弹一条系统通知。
- **socket 文件 0600**、`~/.byob/` 目录 0700、bridge 进程强制 `umask(0o077)`。

### 标记延后到 v0.2

- 取消 / Abort 传播（MCP 客户端取消 → bridge → CDP detach）
- CDP 失败时 fallback 到 `chrome.scripting.executeScript`
- `browser_download_images` 独立工具（大 payload 走 loopback HTTP）
- Wake / sleep 检测（1s tick，gap > 5s）
- 跨 frame iframe 操作（`Page.getFrameTree` + executionContextId）
- 长操作流式进度（MCP `setStatus`）
- containerTree 结构化输出
- session-handle 增量 chunk 收集
- Chrome Web Store 上架
