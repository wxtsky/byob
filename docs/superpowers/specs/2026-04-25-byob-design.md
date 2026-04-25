---
title: byob — Bring Your Own Browser (Design)
status: approved-for-planning
date: 2026-04-25
author: wxt + Claude
---

# byob — Bring Your Own Browser

让本地 AI agent（Claude Code / Cursor / Cline / 自建 agent）通过用户已登录的真实 Chrome 浏览器抓页面、点击、截图、导出 cookie。架构灵感来自 Dokobot，去掉 SaaS 形态、in-page UI 气泡、LLM 代码沙箱，专注本地 MCP 形态。

---

## Table of Contents

1. [Goals & Non-Goals](#goals--non-goals)
2. [High-Level Architecture](#high-level-architecture)
3. [Repository Structure](#repository-structure)
4. [Tool Catalog (10 MCP Tools)](#tool-catalog-10-mcp-tools)
5. [Data Flow](#data-flow)
6. [Native Messaging Protocol](#native-messaging-protocol)
7. [Bridge IPC Protocol (UNIX socket HTTP)](#bridge-ipc-protocol-unix-socket-http)
8. [Security Model](#security-model)
9. [Error Model](#error-model)
10. [Lifecycle & Multi-Instance](#lifecycle--multi-instance)
11. [Management CLI & Onboarding](#management-cli--onboarding)
12. [Development Workflow](#development-workflow)
13. [Testing Strategy (E2E Checklist)](#testing-strategy-e2e-checklist)
14. [Release Strategy](#release-strategy)
15. [Open Questions](#open-questions)
16. [Appendix: Rejected Alternatives](#appendix-rejected-alternatives)

---

## Goals & Non-Goals

### Goals

- 本地 AI agent 通过 MCP 协议调用真实 Chrome，复用用户已登录的 cookie/session
- 10 个 MCP tool 覆盖"读、点、填、看、跳、等、导 cookie、跑 JS"
- 安全为先：`browser_eval` 默认禁用、URL 黑名单、socket 文件 600 权限
- 跨多个 MCP 客户端可用（不绑死 Claude Code）
- 首期跑通本地 dogfood，~3-5 天工作量到 MVP

### Non-Goals (explicit)

- ❌ **SaaS 形态** —— 没有云端、没有 dokobot.ai 那种 `externally_connectable` 网页通道、没有 SSE 远程决策接口
- ❌ **In-page 浮动 UI** —— 不注入侧边栏 / 气泡 / 提示框到用户网页
- ❌ **Sandbox iframe 跑 LLM 生成代码** —— LLM 代码执行只通过 `browser_eval`（高危默认关）
- ❌ **加密 envelope** —— 数据全程不出本机，明文 JSON 即可
- ❌ **跨域 iframe 操作** —— v1 只支持 main frame，跨域 iframe v2 再说
- ❌ **Chrome Web Store 上架** —— 首期走"加载已解压"模式
- ❌ **单元测试** —— e2e 手工清单替代

---

## High-Level Architecture

```
┌───────────────────────┐
│ Claude Code / Cursor  │
│ / Cline / 自建 agent  │
└──────────┬────────────┘
           │ MCP stdio (JSON-RPC over stdin/stdout)
           ▼
┌───────────────────────┐
│ byob-mcp              │  spawn 子进程方式启动
│ (Node stdio server)   │  暴露 10 个 tool
└──────────┬────────────┘
           │ HTTP over UNIX domain socket
           │ ~/.byob/bridges/<deviceId>.sock
           ▼
┌───────────────────────┐
│ byob-bridge           │  常驻 Node 进程
│ (Native Msg Host)     │  Chrome 主动拉起
│                       │  hello/result 异步队列
└──────────┬────────────┘
           │ Chrome Native Messaging
           │ frame: 4-byte LE length + UTF-8 JSON body
           ▼
┌───────────────────────┐
│ byob-extension        │  WXT 构建产物
│ (MV3 Service Worker)  │  command dispatcher
│                       │  CDP session 管理
└──────────┬────────────┘
           │ chrome.debugger (Chrome DevTools Protocol)
           ▼
┌───────────────────────┐
│ Chrome Tab (真实浏览器)│  ← 复用用户 cookie / 登录态 / 反爬豁免
└───────────────────────┘
```

### 跨进程边界总览

| 边界 | 协议 | 序列化 | 双工 |
|---|---|---|---|
| MCP Client ↔ byob-mcp | MCP (JSON-RPC 2.0) | JSON | ✓ stdio |
| byob-mcp ↔ byob-bridge | HTTP/1.1 | JSON | 半双工（请求-响应） |
| byob-bridge ↔ extension | Chrome Native Messaging | 4B LE + JSON | ✓ 全双工 |
| extension ↔ Chrome Tab | Chrome DevTools Protocol | JSON | ✓ 全双工 |

---

## Repository Structure

```
byob/
├── package.json                      # bun workspaces 入口
├── tsconfig.base.json
├── bunfig.toml
├── .gitignore
├── README.md
├── docs/
│   └── superpowers/
│       └── specs/
│           └── 2026-04-25-byob-design.md   # 本文档
├── shared/                           # 跨包共享，叶子包
│   ├── package.json                  # name: "@byob/shared"
│   └── src/
│       ├── commands.ts               # 10 个 command 名常量
│       ├── schemas.ts                # Zod schema (req/resp)
│       ├── errors.ts                 # ErrorCode 枚举
│       └── index.ts
└── packages/
    ├── extension/                    # WXT 项目
    │   ├── wxt.config.ts
    │   ├── package.json              # name: "@byob/extension"
    │   ├── entrypoints/
    │   │   ├── background.ts         # service worker = command dispatcher
    │   │   └── offscreen.ts          # 隐藏 document（图片解码备用）
    │   ├── lib/
    │   │   ├── native-msg.ts         # connectNative + 重连
    │   │   ├── cdp.ts                # CDPSession class + Wi map (tabId→session)
    │   │   ├── tab.ts                # 开/复用 tab 的统一包装
    │   │   ├── url-guard.ts          # URL 黑名单检查
    │   │   └── handlers/
    │   │       ├── read.ts
    │   │       ├── screenshot.ts
    │   │       ├── click.ts
    │   │       ├── type.ts
    │   │       ├── get-cookies.ts
    │   │       ├── eval.ts
    │   │       ├── navigate.ts
    │   │       ├── wait-for.ts
    │   │       ├── list-tabs.ts
    │   │       └── switch-tab.ts
    │   └── public/
    │       └── icons/
    ├── bridge/                       # Native Messaging Host
    │   ├── package.json              # name: "@byob/bridge"
    │   ├── bin/
    │   │   ├── byob.ts               # 管理 CLI 入口（install/doctor/...）
    │   │   └── byob-bridge.ts        # bridge 进程入口（被 launcher.sh 拉起）
    │   └── src/
    │       ├── main.ts               # bridge 主循环
    │       ├── native-messaging.ts   # 4B LE 帧编解码
    │       ├── ipc-server.ts         # UNIX socket HTTP server
    │       ├── bridge-registry.ts    # ~/.byob/bridges.json 读写 + 探活
    │       ├── install.ts            # `byob install` 实现
    │       ├── doctor.ts             # `byob doctor` 实现
    │       └── extension-id.ts       # 从公钥算扩展 ID
    └── mcp-server/                   # MCP server
        ├── package.json              # name: "@byob/mcp-server"
        ├── bin/
        │   └── byob-mcp.ts           # MCP client 配置里指向这个
        └── src/
            ├── server.ts             # registerTool × 10
            ├── bridge-client.ts      # undici Agent + UNIX socket
            ├── error-mapper.ts       # bridge 错误 → MCP isError + hint
            └── tools/
                ├── browser-read.ts
                ├── browser-screenshot.ts
                ├── ...               # 共 10 个
```

### 包间依赖

```
@byob/mcp-server  ──┐
                    ├──▶ @byob/shared
@byob/extension   ──┤
@byob/bridge      ──┘
```

`@byob/shared` 是叶子包；扩展、bridge、mcp-server 三方共用同一份 Zod schema 和 command 名常量，杜绝跨进程 API 漂移。

---

## Tool Catalog (10 MCP Tools)

每个 tool 通过 `@modelcontextprotocol/sdk` 的 `server.registerTool()` 注册。`browser_eval` 在 `BYOB_ALLOW_EVAL !== '1'` 时不注册（LLM 看不到该 tool）。

### 1. `browser_read`

读取网页全文。CDP 主路径 + content-script fallback；自动滚动加载懒加载内容；返回结构化 chunk。

```ts
Input  = { url, screens=3, timeoutSec=60, sessionId?, reuseTab=false }
Output = { text, title, url, chunks[], sessionId, canContinue, stopReason }

Chunk  = { id, sourceIds[], text, bounds:[x,y,w,h], zIndex?, containerId? }
stopReason ∈ 'end_of_scroll' | 'timeout' | 'limit_reached'
```

**断点续读**：传 `sessionId` 复用上次的 CDP session 继续往下滚。

### 2. `browser_screenshot`

CDP `Page.captureScreenshot`，保存为文件返回路径（**不返 base64**，避免占满 LLM 上下文）。

```ts
Input  = { url? | tabId?, fullPage=false, format='png', quality?, savePath? }
Output = { path, width, height, format }
```

`savePath` 默认 `~/.byob/screenshots/<timestamp>.<ext>`。

### 3. `browser_click`

CDP `Input.dispatchMouseEvent`，发真实鼠标事件（不是合成 DOM event）。

```ts
Input  = { selector, tabId?, button='left', clickCount=1, modifiers=[] }
Output = { success: true, elementText? }
```

### 4. `browser_type`

CDP `Input.insertText` + 可选 Enter。

```ts
Input  = { selector, text, tabId?, clear=false, pressEnter=false }
Output = { success: true }
```

### 5. `browser_get_cookies` ★ 关键差异化

通过 `chrome.cookies.getAll()`（带 partition 支持）导出 cookie。让 LLM 拿到后能 `curl` 别处复用 session，不用每次都开浏览器。

```ts
Input  = { domain? | url? }
Output = { cookies: Cookie[] }

Cookie = {
  name, value, domain, path,
  expires?, httpOnly, secure, sameSite?, partitionKey?
}
```

### 6. `browser_eval` ★ 高危·默认禁用

CDP `Runtime.evaluate`，在页面 MAIN world 跑任意 JS。

```ts
Input  = { code, tabId?, awaitPromise=true, returnByValue=true }
Output = { result, type, exceptionDetails? }
```

**护栏**：见 [Security Model § eval 三道护栏](#1-browser_eval-三道护栏)。

### 7. `browser_navigate`

复用 tab 跳转，等待加载。

```ts
Input  = { url, tabId?, waitUntil='load', timeoutSec=30 }
Output = { tabId, url, title }

waitUntil ∈ 'load' | 'domcontentloaded' | 'networkidle'
```

### 8. `browser_wait_for`

注入 MutationObserver 等元素出现/消失。

```ts
Input  = { selector, tabId?, state='visible', timeoutSec=10 }
Output = { found: true, elapsedMs }

state ∈ 'visible' | 'hidden' | 'attached' | 'detached'
```

### 9. `browser_list_tabs`

```ts
Input  = {}
Output = { tabs: Array<{ id, url, title, active, windowId }> }
```

### 10. `browser_switch_tab`

```ts
Input  = { tabId }
Output = { success: true }
```

### Tool 默认对象规则

| 类别 | 不传 `tabId` 时的默认行为 |
|---|---|
| `browser_read` / `browser_navigate` | 开**新后台 tab**，操作完按需关闭 |
| `browser_screenshot` | 优先用当前 active tab；传 `url` 则开后台 tab |
| `browser_click` / `browser_type` / `browser_eval` / `browser_wait_for` | 操作 **active tab**（用户能看见效果，便于调试） |

---

## Data Flow

以 `browser_read("https://example.com")` 为例的完整端到端调用链：

```
1. Claude Code 发现 byob-mcp 注册的 browser_read tool, LLM 决定调用
2. Claude Code 通过 stdio 发 JSON-RPC: tools/call { name:"browser_read", arguments:{url:"..."} }
3. byob-mcp:
   ├── Zod 校验 arguments
   ├── 读 ~/.byob/bridges.json 找活的 bridge
   ├── undici Agent({ connect:{socketPath} }) POST http://localhost/read
4. byob-bridge:
   ├── ipc-server.ts handleRead(body)
   ├── 生成 requestId = crypto.randomUUID()
   ├── pendingRequests.set(requestId, {resolve, timer})
   ├── writeMessage({ type:"command", requestId, command:"readPage", params })
   └── 等待
5. Chrome 收到 stdout 帧 → 派发给扩展的 connectNative Port
6. byob-extension background.ts:
   ├── onMessage 收到 {type:"command", command:"readPage", ...}
   ├── dispatch → handlers/read.ts
   ├── url-guard 检查 URL 不在黑名单
   ├── tab.openOrReuse(url) → 拿到 tabId
   ├── cdp.attach(tabId) → 注入 __byobCDP runtime
   ├── 循环: scroll + collect chunks 直到 end_of_scroll | noGrowthRounds 触发
   ├── port.postMessage({ type:"result", requestId, success:true, data:{...} })
   └── tab 按规则关闭
7. byob-bridge:
   ├── stdin 收到 result 帧
   ├── pendingRequests.get(requestId).resolve(result)
   └── HTTP 200 返 JSON 给 byob-mcp
8. byob-mcp:
   ├── Zod 校验 response
   ├── 包成 { content:[{type:"text", text: JSON.stringify(result)}] }
   └── stdio 写回 Claude Code
9. Claude Code 把结果喂回 LLM
```

每一跳都有独立的 abort 传播链，见 [Security Model § Abort 传播](#abort-传播).

---

## Native Messaging Protocol

### 帧格式

Chrome 标准协议，bridge 这一层直接照抄：

```
┌─────────────────┬─────────────────────────────┐
│ 4 bytes LE len  │  UTF-8 JSON body (len 字节) │
└─────────────────┴─────────────────────────────┘
```

**单条消息上限 1MB**（扩展→host 方向）。大 payload（截图、HTML 文本）用 [loopback HTTP](#大-payload-loopback-http) 绕开。

### 消息类型

```ts
// extension → bridge
type ExtToBridge =
  | { type: 'hello',  deviceId: string }
  | { type: 'result', requestId: string, success: boolean, data?: unknown, error?: string, aborted?: boolean }
  | { type: 'log',    level: 'info'|'warn'|'error', msg: string }
  | { type: 'wake',   gapMs: number }    // mac 唤醒检测,bridge 收到不做事只记日志

// bridge → extension
type BridgeToExt =
  | { type: 'status',  status: 'ready' }
  | { type: 'command', requestId: string, command: string, params: unknown }
  | { type: 'cancel',  requestId: string }
```

### 大 payload Loopback HTTP

`browser_screenshot` 这种动辄 MB 级的 PNG 不走 Native Messaging。bridge 临时开 `127.0.0.1:<random>` HTTP server，把 endpoint + secret 通过 Native Messaging 告诉扩展，扩展直接 `fetch(endpoint, { method:'POST', body: pngBytes })`。bridge 写盘后 close server。

---

## Bridge IPC Protocol (UNIX socket HTTP)

mcp-server 通过 undici Agent 连 UNIX socket，发标准 HTTP/1.1。socket 路径：`~/.byob/bridges/<deviceId>.sock`，权限 `0600`。

### 端点

| Method | Path | Body | 200 Body | 用途 |
|---|---|---|---|---|
| GET  | `/status`            | —                                         | `{connected:bool, deviceId, sinceMs}` | 健康检查 |
| POST | `/read`              | ReadInput                                 | ReadOutput                            | browser_read |
| POST | `/screenshot`        | ScreenshotInput + saveDir                 | ScreenshotOutput                      | browser_screenshot |
| POST | `/click`             | ClickInput                                | ClickOutput                           | browser_click |
| POST | `/type`              | TypeInput                                 | TypeOutput                            | browser_type |
| POST | `/cookies`           | GetCookiesInput                           | GetCookiesOutput                      | browser_get_cookies |
| POST | `/eval`              | EvalInput                                 | EvalOutput                            | browser_eval |
| POST | `/navigate`          | NavigateInput                             | NavigateOutput                        | browser_navigate |
| POST | `/wait-for`          | WaitForInput                              | WaitForOutput                         | browser_wait_for |
| GET  | `/tabs`              | —                                         | ListTabsOutput                        | browser_list_tabs |
| POST | `/tabs/switch`       | SwitchTabInput                            | SwitchTabOutput                       | browser_switch_tab |

错误统一返：

```json
HTTP/1.1 502 Bad Gateway
Content-Type: application/json

{ "error": "extension_not_connected",
  "message": "Bridge is running but extension not connected",
  "hint":    "Open Chrome with byob extension enabled" }
```

### Abort

mcp-server 关闭 HTTP 连接 → bridge `req.on('close')` 触发 → bridge 发 `{type:'cancel', requestId}` 给扩展 → extension 调对应 AbortController.abort() → CDP 命令抛 AbortError → handler 清理后回 `aborted:true`。

---

## Security Model

### 1. `browser_eval` 三道护栏

```
① mcp-server 启动时:
   if (process.env.BYOB_ALLOW_EVAL !== '1') {
     // 不调 server.registerTool('browser_eval',...)
     // → LLM 的 tools 列表里根本没这一项
     return;
   }

② mcp-server → bridge HTTP 时附:
   X-Byob-Eval-Origin: pid=<mcp pid>; cwd=<process.cwd()>
   bridge 收到后 append 一行到 ~/.byob/eval-audit.log:
   <ISO time> origin=<header值> code=<前 200 字>

③ extension 收到 evalRequest 时:
   chrome.notifications.create('byob-eval-<reqid>', {
     type:'basic', iconUrl:..., title:'byob: evaluating JS',
     message: `tab ${tabId} (${url}): ${code.slice(0,80)}…`,
   });
   throttle: 同一 tab > 5 次/分钟 → 拒绝并报 RATE_LIMITED
```

### 2. URL 黑名单（默认禁，env 解锁）

```ts
const FORBIDDEN_PROTOCOLS = ['chrome:', 'chrome-extension:', 'about:', 'devtools:', 'view-source:', 'file:'];
const FORBIDDEN_HOSTS = ['accounts.google.com', 'login.microsoftonline.com', 'appleid.apple.com'];

// env 解锁:
//   BYOB_ALLOW_FILE=1            → 允许 file:
//   BYOB_ALLOW_AUTH_DOMAINS=1    → 允许默认禁的认证域
//   BYOB_FORBIDDEN_HOSTS=a,b,c   → 用户自定义补充
```

### 3. Socket 文件权限

```
~/.byob/                      0700
~/.byob/bridges/              0700
~/.byob/bridges/*.sock        0600
~/.byob/eval-audit.log        0600
~/.byob/bridge.log            0600
```

bridge 启动时 `process.umask(0o077)`，确保后续 mkdir/createSocket 默认权限正确。

### 4. Chrome 黄条警告（已知约束）

`chrome.debugger.attach` 后 Chrome 强制在 tab 顶部显示"byob 正在调试此标签页"黄条。**这是 Chrome 安全设计、无法关闭**。README 显眼位置写明，避免用户误以为是 bug。

### Abort 传播

```
MCP Client cancels tool call
    ↓ AbortSignal
byob-mcp: fetch(...).abort()
    ↓ TCP RST on UNIX socket
byob-bridge: req.on('close')
    ↓ Native Messaging
byob-extension: cancelRequestId 找到对应 AbortController.abort()
    ↓ AbortSignal
CDP sendCommand throws AbortError
    ↓
handler 清理 (CDP detach, tab close) → 回 { aborted: true }
```

---

## Error Model

### `shared/src/errors.ts`

```ts
export const ErrorCode = {
  // 链路层
  BRIDGE_NOT_RUNNING:      'bridge_not_running',
  EXTENSION_NOT_CONNECTED: 'extension_not_connected',
  CHROME_NOT_RUNNING:      'chrome_not_running',
  // CDP 层
  CDP_ATTACH_FAILED:       'cdp_attach_failed',
  CDP_DETACHED_UNEXPECTED: 'cdp_detached',
  TAB_CLOSED:              'tab_closed',
  TAB_NAVIGATED:           'tab_navigated',
  // 操作层
  TIMEOUT:                 'timeout',
  SELECTOR_NOT_FOUND:      'selector_not_found',
  ELEMENT_NOT_VISIBLE:     'element_not_visible',
  EVAL_DISABLED:           'eval_disabled',
  EVAL_EXCEPTION:          'eval_exception',
  // 安全层
  URL_FORBIDDEN:           'url_forbidden',
  RATE_LIMITED:            'rate_limited',
} as const;
```

### MCP 返回（不抛 protocol error）

```ts
// 失败时
return {
  isError: true,
  content: [{
    type: 'text',
    text: JSON.stringify({
      error: ErrorCode.BRIDGE_NOT_RUNNING,
      message: 'Bridge process not responding.',
      hint: 'Run: byob doctor   to diagnose.',
    }),
  }],
};
```

让 LLM 看到 `error` 字段就能自适应：重试 / 切策略 / 报告用户。每个 error 必带 `hint` 引导用户。

### CDP 路径降级（仅 `browser_read`）

```
试 chrome.debugger.attach + Runtime.evaluate
├── 成功 → CDP 路径
└── 失败 (F12 占用 / chrome:// 页) →
    试 chrome.scripting.executeScript({world:'MAIN'})
    ├── 成功 → content script 路径（功能略阉割，stopReason 加 'fallback'）
    └── 失败 → 报 CDP_ATTACH_FAILED
```

`browser_click/type/eval` **不降级**，CDP 失败直接报错（合成 DOM event 反爬识别得出来，没有意义）。

---

## Lifecycle & Multi-Instance

### Bridge 生命周期

Bridge 进程 **不是 daemon**，由 Chrome 主动拉起：

```
Chrome 启动
  ↓ 扩展 service worker 激活
  ↓ chrome.runtime.connectNative('ai.byob.bridge')
Chrome fork bridge 进程, 接好 stdin/stdout
  ↓ extension 发 {type:'hello', deviceId}
bridge 起 UNIX socket, 写 ~/.byob/bridges.json: {deviceId, pid, socket}
bridge 回 {type:'status', status:'ready'}
  ↓
（运行中）
  ↓
用户关 Chrome / 禁用扩展 / extension Port disconnect
  ↓ stdin emits 'end'
bridge.shutdown(): close socket, unlink .sock 文件, 删 registry 项, exit(0)
```

### Multi-Instance（多 Chrome profile）

每个 Chrome profile 的扩展独立 connectNative，每个 profile 起一个独立 bridge 进程，每个一个 deviceId 一个 socket。

```
~/.byob/bridges.json:
[
  { "deviceId": "abc123", "pid": 12345, "socket": "~/.byob/bridges/abc123.sock" },
  { "deviceId": "def456", "pid": 12346, "socket": "~/.byob/bridges/def456.sock" }
]
```

mcp-server 启动时调 `resolveBridge(env.BYOB_DEVICE_ID)`：

- 没设 env + 只有一个活 bridge → 用它
- 没设 env + 多个活 bridge → 启动失败，报错让用户设 `BYOB_DEVICE_ID`
- 设了 env → 找匹配的，找不到也报错

`process.kill(pid, 0)` 探活，死的项自动清理。

### Service Worker Keep-Alive

MV3 SW 30s 空闲被杀。两手保活：

```ts
// 1. Alarms 兜底（5 分钟以内任务）
chrome.alarms.create('keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(() => {});

// 2. 长任务期间显式
async function withKeepAwake<T>(fn: () => Promise<T>): Promise<T> {
  chrome.power.requestKeepAwake('display');
  try { return await fn(); }
  finally { chrome.power.releaseKeepAwake(); }
}
```

### Wake 检测

bridge 每秒 tick，gap > 5s 推断系统刚唤醒，发 `{type:'wake', gapMs}` 给 extension。extension 收到后重置 CDP session 状态（如果有挂起的）。

---

## Management CLI & Onboarding

`@byob/bridge` 包暴露 binary `byob`（管理 CLI）和 `byob-bridge`（被 launcher 调用的 NM host）。

### 命令清单

```
byob install [--browser chrome,brave,edge] [--dev]
  写 launcher.sh + Native Messaging manifest 到所有支持的浏览器
  --dev: launcher 跑 tsx 直接执行 TS 源文件,省构建

byob uninstall
  反向清理 manifest + launcher

byob doctor
  诊断 manifest / bridge 进程 / extension 连接 / socket
  打印每一项 ✓/✗ + 修复建议

byob bridges
  列出当前活跃 bridge: deviceId / pid / socket / 上次活跃时间

byob logs [-f] [--since <duration>]
  tail bridge.log

byob version
```

### `byob doctor` 输出样例

```
$ byob doctor

Native Messaging Manifests:
  ✓ Chrome  (~/Library/Application Support/Google/Chrome/NativeMessagingHosts/ai.byob.bridge.json)
  ✓ Brave   (~/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/...)
  - Edge    (not installed, skipped — no Edge detected)

Launcher:
  ✓ ~/.byob/bridge-host.sh exists, executable

Bridge Process:
  ✓ Running (pid 12345, deviceId abc123, uptime 3h 22m)

Extension Connection:
  ✓ Connected (last hello 14s ago)

Socket:
  ✓ Reachable: ~/.byob/bridges/abc123.sock

MCP Client Setup:
  Claude Code:  claude mcp add byob byob-mcp
  Cursor:       add to settings.json: "mcp.servers": { "byob": { "command": "byob-mcp" } }
  Cline:        add to ~/.cline/config.json ...

Everything looks good. Try asking your AI: "use byob to read https://news.ycombinator.com"
```

### 安装链路

```
1. 全局安装产物
   bun add -g @byob/cli   # 暴露 byob, byob-bridge, byob-mcp 三个 binary

2. byob install
   ├── 算扩展 ID (从 RSA 公钥)
   ├── 写 ~/.byob/bridge-host.sh:
   │     #!/bin/sh
   │     export PATH="<embedded node dir>:$PATH"
   │     exec "<embedded node>" "<bridge entry>" "$@"
   ├── 写 Native Messaging manifest 到三浏览器目录
   └── 提示用户去 chrome://extensions 装扩展

3. 用户装扩展
   chrome://extensions → 加载已解压扩展 → packages/extension/.output/chrome-mv3

4. 重启 Chrome → 扩展加载 → connectNative → bridge 启动 → socket 就绪

5. 用户配 MCP
   claude mcp add byob byob-mcp
   AI 立即可用
```

---

## Development Workflow

### 本地开发循环（5 个终端）

```
T1:  cd packages/extension  && bun run dev       # WXT HMR → .output/chrome-mv3/
T2:  cd packages/bridge     && bun run dev       # tsx watch bin/byob-bridge.ts
T3:  cd packages/mcp-server && bun run dev       # tsx watch bin/byob-mcp.ts
T4:  tail -f ~/.byob/bridge.log
T5:  curl --unix-socket ~/.byob/bridges/abc.sock http://x/status   # 手动测
```

### 关键 trick：`byob install --dev`

开发期 launcher 写成调 `tsx` 执行源文件，省去每次 build：

```sh
#!/bin/sh
export PATH="<node dir>:<global tsx dir>:$PATH"
exec tsx /Users/wxt/code/byob/packages/bridge/bin/byob-bridge.ts "$@"
```

WXT 改扩展 → SW reload → connectNative 重连（指数退避会自动接上） → 完整热更新闭环。

### TypeScript 配置

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "esModuleInterop": true
  }
}
```

每包自己的 `tsconfig.json` extends 它，按需加 `lib` / `types`（扩展加 `chrome-types`）。

### Lint

`bun fmt` 内置（基于 prettier）。Lint 用最简 eslint 配置，只开 `@typescript-eslint/no-floating-promises` + `no-unused-vars`，不上规则地狱。

---

## Testing Strategy (E2E Checklist)

不写单元测试。`docs/e2e-checklist.md` 维护一份手工验证清单，每次发版前跑一遍。

### 链路连通

- [ ] `byob install` 成功 + `byob doctor` 全绿
- [ ] 扩展首次连 bridge 触发 hello → bridge 起 socket
- [ ] `curl --unix-socket ~/.byob/bridges/<id>.sock http://x/status` → `{connected:true}`

### 10 个 tool 各跑通一次

- [ ] `browser_read https://news.ycombinator.com` → 抓到 stories 文本
- [ ] `browser_read https://x.com/anthropic` → 抓到登录态推文（验 cookie 复用）
- [ ] `browser_screenshot https://github.com` → PNG 落到 `~/.byob/screenshots/`
- [ ] `browser_click` 在 Google 搜索框点击
- [ ] `browser_type` 填关键词 + pressEnter
- [ ] `browser_get_cookies github.com` → 拿到 `user_session` cookie
- [ ] `browser_eval`（`BYOB_ALLOW_EVAL=1`） `document.title`
- [ ] `browser_navigate` 复用 tab 跳转
- [ ] `browser_wait_for` 等 SPA 加载新内容
- [ ] `browser_list_tabs` / `browser_switch_tab`

### 错误路径

- [ ] 用户开 F12 后 `browser_click` → `CDP_ATTACH_FAILED` + hint
- [ ] 关闭 Chrome 后调任何 tool → `BRIDGE_NOT_RUNNING`
- [ ] `BYOB_ALLOW_EVAL` 未设时 `browser_eval` tool 不出现在 `tools/list`
- [ ] 操作中关 tab → `TAB_CLOSED`
- [ ] timeout 超时 → 正确清理 + `TIMEOUT`
- [ ] `browser_read file:///etc/passwd` → `URL_FORBIDDEN`

### MCP 客户端集成

- [ ] Claude Code 里 "帮我读 X 网页评论" 自动调 `browser_read`
- [ ] Cursor 里同上
- [ ] 取消 tool call (Ctrl+C) → bridge 收到 abort → CDP detach 干净

---

## Release Strategy

| 制品 | 渠道 | 时机 |
|---|---|---|
| `@byob/cli` (含 byob, byob-bridge, byob-mcp) | npm | 跑通 e2e 后发 0.1.0 |
| `byob-extension` (chrome-mv3 unpacked) | GitHub Releases zip + 文档 | 与 CLI 同版本 |
| Chrome Web Store 上架 | **首期不做** | v1.0 稳定后再考虑 |

### 为何首期不上架 Web Store

1. CWS 审核 `nativeMessaging` 权限严格，要写一长篇 justification
2. 上架后 ID 是 Google 分配的 ≠ RSA 公钥算的，bridge `allowed_origins` 要换
3. 上架后扩展自动更新，bridge 没跟上版本就崩
4. 首期 dogfood 阶段没必要

### 版本一致性

extension / bridge / mcp-server 共用一个版本号（monorepo 同步发版）。`byob doctor` 检查三方版本号是否一致，不一致警告。

---

## Open Questions

留给 Plan 阶段决策的小坑：

1. **chunk 提取算法的细节** —— 怎么从 DOM 切 chunk？方案：每个叶子节点（`!hasChildren && !!innerText.trim()`）当一个 chunk，用 `getBoundingClientRect` 拿 bounds。但表格/列表的语义聚合要不要做？v1 先不做。
2. **`browser_screenshot` 的 fullPage 实现** —— CDP `Page.captureScreenshot {captureBeyondViewport:true}` 一把梭，还是滚动拼？前者简单，后者对长页面更稳。先用前者。
3. **WXT 怎么注入 RSA 公钥固定 extension ID** —— WXT 的 `wxt.config.ts` 里 `manifest.key` 字段直接写 base64 即可，验证一下。
4. **`@modelcontextprotocol/sdk` 最新 API 形态** —— `McpServer` vs `Server` class、`registerTool` vs `tool` 方法名 — 实施前查一遍最新文档。
5. **bridge launcher 是否要支持 nvm/fnm 多 node 切换** —— 首期硬编码 `process.execPath`，跨用户机器时再说。

---

## Appendix: Rejected Alternatives

| 方案 | 拒绝理由 |
|---|---|
| **CRXJS / Plasmo 做扩展** | 维护停滞 / 体积大；WXT 是 2026 事实标准 |
| **bun 跑 bridge** | Anthropic 自己的 Claude in Chrome 在 Bun 1.3.5 + Windows 上崩（GH issue 21838），Native Messaging stdio 边界场景 bun 是二等公民 |
| **MCP HTTP transport** | 本地服务用 stdio 是 SDK 推荐，HTTP 是给云端 server 用，本地多此一举 |
| **content script 抓正文为主路径** | content script 跨域 iframe 受限、无法触发真实输入事件、易被反爬识别；CDP 是唯一正解 |
| **Mozilla Readability 提取正文** | LLM 时代不需要"阅读模式"风格的剥皮，结构化 chunk + bounds 信息量更大 |
| **In-page UI 浮动气泡** | 跟 byob 的"无感后台"定位冲突；用户已经有 MCP client UI |
| **加密 envelope** | 无 SaaS 场景，数据不出本机，明文 JSON 简单可靠 |
| **首期就上 Chrome Web Store** | nativeMessaging 审核重 + 自动更新破协议，dogfood 期不值 |
| **共享 schema 用 OpenAPI/Protobuf** | Zod 一份代码三方都用 + 直接生成 MCP tool schema，OpenAPI/Protobuf 重得多 |
| **首期写单元测试** | 主要 bug 都在跨进程边界 / Chrome API 行为 / CDP 兼容性，单测覆盖不到；e2e 清单更划算 |

---

**End of Spec.**
