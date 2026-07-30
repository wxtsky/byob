# Changelog (中文)

[English](CHANGELOG.md) · **中文**

> 完整英文版以 [CHANGELOG.md](CHANGELOG.md) 为准。中文版主要给中文圈快速浏览。

---

## [0.4.1] — 2026-07-30

### 修复

- Native Messaging bridge 同时启动时，将 `EADDRINUSE` / `EEXIST`
  作为正常的单实例竞争处理，不再产生 uncaught 崩溃。
- 竞争失败的 bridge 不再误删赢家进程的 IPC socket 或 registry 记录；
  退出清理只处理当前 PID 真正拥有的资源。
- Chrome 关闭 Native Messaging stdout 后，bridge 现在以
  `stdout_closed` 正常退出，不再产生 uncaught `EPIPE`。
- 新增真实子进程回归测试，覆盖并发启动竞争和 stdout 提前关闭。

---

## [0.4.0] — 2026-07-30

### Claude Code 插件

- 仓库现在同时是一个 **Claude Code 插件 marketplace**。`byob` 插件自带
  MCP Server 和 `/byob:control-chrome` Skill，Claude Code 用户不再需要
  额外执行 `claude mcp add`；setup 重复运行时会自动 install / update。
- release build 会生成不依赖 workspace 的单文件 MCP bundle，Claude
  插件缓存可以直接启动。

### 浏览器能力对齐

- 新增 **`browser_snapshot`**：紧凑的无障碍树、`[byob:N]` 元素引用、
  语义层级、输出预算、敏感字段脱敏，并保留无文字图标按钮的可操作索引。
- 新增 tab 生命周期工具：`browser_new_tab`、`browser_reload`。
- 新增显式 JS 对话框工具：`browser_get_js_dialog`、
  `browser_handle_js_dialog`。alert / confirm / prompt / beforeunload 只记录，
  绝不会自动替用户确认。
- 新增 `browser_history`、`browser_clipboard_read_text`、
  `browser_clipboard_write_text`。
- click / double-click / hover 支持视口坐标；type 可输入当前焦点元素；
  scroll 支持 wheel gesture；screenshot 支持矩形裁剪。
- MCP 默认暴露 **40 个工具**；`browser_eval` 仍需显式设置
  `BYOB_ALLOW_EVAL=1` 才出现。

### 安全

- 新增 `BYOB_ALLOWED_DOMAINS` / `BYOB_DENIED_DOMAINS` 站点策略，覆盖 CDP
  与非 CDP 操作，也覆盖只传 `tabId` 的工具。
- 复用缓存 CDP session 前重新检查 tab 的实时 URL，避免 tab 从允许站点
  跳到拒绝站点后绕过策略。
- Service Worker 唤醒后，首条命令会等待 URL 策略加载完成，消除短暂默认
  放行窗口。
- password / OTP / 卡号 / 身份类输入字段在交互输出中统一脱敏。

### 可靠性与兼容性

- Windows IPC 改用 Named Pipe；setup 同时识别 Bun `.exe` 和 npm `.cmd`
  shim，注册失败会明确报错，卸载时也能处理被占用的 launcher。
- routes 和 MCP tools 改为共享声明式注册，减少 bridge / server 两侧拼写漂移。
- 加固 Native Messaging frame、上传大小限制、取消链路、iframe 坐标、
  CDP 清理、storage 截断和正则输入。
- 一键安装支持 fork、固定 ref、Windows Git Bash/MSYS2、原生安装 Bun，
  Claude 插件也可重复更新。

---

## [0.3.3] — 2026-04-28

### 修复

- **`browser_eval`** 错误信封现在透传 CDP `exceptionDetails`（line/col/stack），
  调用方能定位到页面侧的实际抛出点，而不是只看到泛泛的 "Page threw during eval"。
- **`browser_screenshot`** — bridge 在写用户传入的 `savePath` 前会 `mkdir -p`
  父目录，之前父目录不存在会 `ENOENT`。
- **`browser_screenshot`** — 返回的 `width`/`height` 现在跟实际生成的图片
  一致：`fullPage:false` 时返回 viewport 尺寸，`fullPage:true` 时返回完整
  滚动区域。之前一律返回 `documentElement.scrollHeight`，跟 `fullPage:false`
  生成的 PNG 对不上。
- **`browser_screenshot`** — 超出大小限制时的错误提示新增
  `browser_emulate_device` 作为备选方案（之前只提到 `fullPage:false` 和
  `format:jpeg`）。
- **URL guard** — `chrome-extension://` 默认不再被屏蔽。byob 自己就是扩展，
  CDP 也能 attach 扩展页；钱包 / 工具类扩展（Rabby、MetaMask 等）经常是
  审查目标。
- **URL guard** — `BYOB_ALLOW_FILE` / `BYOB_ALLOW_AUTH_DOMAINS` 开关真正
  接通了。Background SW 启动时从 `chrome.storage.local` 读取写入内存缓存，
  并监听 `storage.onChanged`。开启方式：byob 扩展 SW 控制台执行
  `chrome.storage.local.set({ BYOB_ALLOW_FILE: true })`。之前 `envFlag` stub
  恒返回 false，但 `url_forbidden` 提示还在让用户设环境变量（设了也没用）。

### 新增

- **`browser_emulate_device`** — 增加 4 个桌面视口 preset，调用方不再需要
  每次写完整的 `custom`：`desktop-1366`（1366×768）/ `desktop-1440`（1440×900 @2×）
  / `desktop-1080p`（1920×1080）/ `desktop-4k`（2560×1440 @2×）。`desktop`
  （无后缀）仍然是清空所有 override。

---

## [0.3.2] — 2026-04-27

### 新增 — 第 3 批：3 个复杂浏览器工具 / 4 个 MCP 工具（29 → 32）

- **`browser_intercept_start`** + **`browser_intercept_stop`** — 通过 CDP
  `Fetch` domain 实现 stateful 请求拦截。rules 数组，每条 `urlPattern`(glob)
  或 `urlRegex`，可选 `methods` 过滤，5 种 action 之一：`block` / `fulfill`
  / `modify`(改请求) / `modifyResponse` / `passthrough`。`modifyResponse`
  支持 `bodyReplace`(整体替换) 或 `bodyRegex`(正则就地替换) — 仅文本类
  Content-Type。复用 `record-network` 的 stateful lifecycle（start 返
  `interceptId`，stop 返命中统计）。
- **`browser_drag`** — 从一点拖到另一点的鼠标拖拽，`durationMs` 时间内
  `steps` 步线性插值。`from` / `to` 各接受 CSS selector 或 `{x, y}` 页面
  坐标。触发鼠标事件；HTML5 `dragstart`/`drag`/`dragend` 不触发。支持
  iframe（`framePath`）。
- **`browser_emulate_device`** — 通过 CDP `Emulation.*Override` 模拟视口/
  DPR/touch/User-Agent。预设：`iphone-17-pro-max`、`iphone-17`、`ipad-pro`、
  `pixel-9-pro`、`galaxy-s25-ultra`、`desktop`(重置)。或 `custom: { width,
  height, deviceScaleFactor, mobile, userAgent? }`。效果持续到重置或
  tab 关闭。

### 新增 — 错误码

- `intercept_not_found` — `intercept_stop` 的 interceptId 不存在或已 drained。

## [0.3.1] — 2026-04-26

### 新增 — 第 2 批：5 个中等复杂度浏览器工具（24 → 29）

- **`browser_set_cookies`** — 通过 `chrome.cookies.set` 写入 cookie（与
  `browser_get_cookies` 对称）。支持 CHIPS partition key 和小写 `sameSite` 枚举。
- **`browser_print_pdf`** — 用 CDP `Page.printToPDF`（流式 `IO.read`）把页面
  存为 PDF。默认目录 `~/.byob/pdfs/`，返回文件路径。支持 A4/Letter/Legal、
  横向、页码范围、统一边距，120 秒超时。
- **`browser_get_storage`** — 读取页面 origin 的 `localStorage` / `sessionStorage`。
  支持 iframe（`framePath`）。超 1MB 会截断（先丢 sessionStorage，再按字典序
  裁剪 localStorage keys）。
- **`browser_get_performance`** — 页面 Web Vitals（LCP/CLS/INP/FCP/TTFB）+
  navigation timing（DCL、load、DNS、TCP、传输大小）。默认 3000ms 采样窗口；
  INP 需要真实用户交互才有值。
- **`browser_upload_file`** — 通过 CDP `DOM.setFileInputFiles` 给
  `<input type="file">` 上传本机文件。Bridge 在转发前校验绝对路径 + `fs.access`。
  自动派发 `input` + `change` 事件。支持 iframe（`framePath`）。

### 新增 — 错误码

- `not_a_file_input` — `upload_file` 的 selector 不是 `<input type="file">`。
- `file_not_found` — `upload_file` 的路径缺失/不可读/非绝对。

---

## [0.3.0] — 2026-04-26

### 新增 8 个工具（16 → 24）

- **`browser_scroll`** —— 滚到页面顶部 / 底部、滚到某个 selector、或滚到指定 Y 坐标。返回最终 `scrollY` + `pageHeight`。
- **`browser_press_key`** —— 发一个键盘事件（Enter / Escape / Tab / F5 / ArrowDown 等），可选 Alt / Control / Shift / Meta 修饰键。
- **`browser_select`** —— 按 value / label / index 选 `<select>` 的 `<option>`。会派发 `input` + `change` 事件，SPA 框架能正常监听。
- **`browser_close_tab`** —— 按 tabId 关闭标签页。
- **`browser_go_back` / `browser_go_forward`** —— 在 tab 的历史栈里前进/后退一步。栈为空时返回 `no_history`。
- **`browser_hover`** —— 把鼠标移到指定元素上（走真实 CDP 鼠标事件），触发 tooltip 和 `:hover` 下拉菜单。
- **`browser_get_html`** —— 返回某个元素（或整个 document）的 outerHTML / innerHTML。按 `maxBytes`（默认 256 KB，最大 8 MB）截断，UTF-8 边界安全。

### 新增错误码

- `option_not_found` —— `<select>` 内按 value / label / index 没找到匹配的 `<option>`。
- `no_history` —— tab 的历史栈里没有可前进 / 后退的条目。

### 内部

- 8 个新增 schema 的单测：覆盖必填字段、XOR 校验、默认值。

---

## [0.2.0] — 2026-04-25

### 5 个新工具（11 → 16）

- **`browser_get_console_logs`** —— 快照某 tab 的 `console.log/warn/error` + 未捕获异常（CDP `Runtime.consoleAPICalled` + `Runtime.exceptionThrown`）。
- **`browser_read_markdown`** —— 页面 → 干净 markdown，走 Mozilla Readability + turndown。**转换在 bridge 进程里跑（jsdom）**，页面本身看不到 Readability 的 DOM。
- **`browser_extract_table`** —— `<table>` → JSON。两种输出（`rows` 原始数组 / `objects` 按表头取键），每张表还附带 `nthOfType` selector 方便后续点击。
- **`browser_start_record_network` / `browser_stop_record_network`** —— 成对的 HTTP + WebSocket 抓包。输出 JSON 或 HAR 1.2（DevTools 直接吃）。底层是 CDP `Network.*` 累加器 + URL pattern 过滤 + SW 被驱逐时的自保。

### iframe 支持（D 线）

- **9 个工具新增 `framePath: string[]` 参数** —— `browser_read / click / type / eval / wait_for / download_images / get_console_logs / read_markdown / extract_table`。每一层用 CSS selector 走嵌套 iframe。
- **跨域 iframe（OOPIF）也工作** —— 走 CDP `Target.setAutoAttach({ flatten: true })`，扩展自动跟进子 session。
- **嵌套 iframe 内点击的页面级坐标换算**（frame-coords 把每层 `getBoundingClientRect` 累加）。
- **4 个新错误码**：`frame_not_found` / `frame_navigation_during_op` / `frame_attach_failed` / `frame_eval_blocked`，每个带 `framePathIndex` + `reason` 告诉 LLM 具体哪一跳挂了。

### Cancel 全链（B.1 线）

- **端到端取消** —— mcp-client `Ctrl+C` → bridge `POST /cancel` → Native Messaging cancel 帧 → handler `AbortSignal` → CDP detach。pending 的 `bridgePost / bridgeGet` 立刻 reject 成新的 `ABORTED` 错误码，不会再等到 10 分钟超时。
- 每次调用的 `requestId` 现在贯穿所有层，每个 handler 都接 `AbortSignal`。

### CDP fallback（B.2 线）

- **`browser_eval` 在 CDP attach 失败时降级到 `chrome.scripting.executeScript`**（比如 tab 开着 DevTools）。fallback 在 page world 跑，返回同样的形状，并在 `_meta.fallbackUsed: true` 里标记，调用方能看出来。

### Wake/sleep 恢复（B.3 线）

- **双检测器** —— `chrome.alarms` 周期心跳 + `chrome.idle` 状态变化。**唤醒后**：把 in-flight 录制全 abort 掉，所有 CDP session 全 detach，下次调用是干净状态。
- 新的 `ABORTED_DUE_TO_WAKE` 错误码，跟用户主动 `Ctrl+C` 区分开。

### 内部

- **70+ 单测**：schema / frame-resolver / har-converter / url-pattern / handler abort 链路（v0.1 这块单测稀疏）。
- `browser_extract_table` 输出加了 `nthOfType` selector hint，方便后续点击对应那张表。

### 修复

- **`browser_extract_table` 隐式 thead 检测** —— 当第一行 `<tr>` 全是 `<th>` 时 Chrome 会自动包一层 `<tbody>`，之前会被当成空表，现在按表头处理。
- **bridge GET 路由接受 `?_requestId=` 查询参数** —— Cancel 全链（B.2）的回归，合并后短暂让 `browser_list_tabs` 挂了。

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
