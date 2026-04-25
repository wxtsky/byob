# C `browser_record_network` 设计

> **状态**：草案，待用户审核
> **日期**：2026-04-25
> **关联**：v0.1 整体设计 [`2026-04-25-byob-design.md`](2026-04-25-byob-design.md)
> **目标版本**：v0.2

## 1. 概述

加 2 个 MCP 工具，把 byob 升级成"AI 自带的浏览器抓包器"：

- `browser_start_record_network` — 启动监听，立返 `recordingId`
- `browser_stop_record_network` — 停下并取所有 records

录制对象：HTTP/HTTPS 请求 + 响应（含 body）+ WebSocket frames，输出 JSON 或 HAR 1.2。

## 2. 动机

byob 目前没法回答"刚才 page 发了哪些 XHR、状态如何、返回啥"。这是前端调试 / API 逆向 / 数据抓取的核心需求。CDP `Network.*` domain 提供了所有所需事件，本 spec 把它包成两个友好工具。

差异化对比：
- 通用 puppeteer / playwright：能抓但要写脚本
- 已有 MCP browser servers：大多没抓包工具，或只抓 metadata 不抓 body
- byob 优势：用户**当前 Chrome session**，登录态完整，能录真实业务流

## 3. 非目标

- 不实时上报 events 给 client（要扩 bridge 协议，单独 spec 处理）
- 不支持 recording 期间动态改 filter（stop + restart 即可）
- 不做 HTTP request mocking / interception（Network domain 不同 surface）
- 不做 SSL 解密 / 证书检查 / cookie jar 操作

## 4. 接口

### 4.1 `browser_start_record_network`

**输入**

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `url` | string? | — | 二选一 |
| `tabId` | number? | — | 二选一 |
| `resourceTypes` | string[]? | `['xhr','fetch']` | 过滤资源类型；`['*']` 表示全要 |
| `urlPattern` | string? | — | glob (e.g. `*api*`) 或正则 (`/regex/`)；命中才记 |
| `includeRequestBody` | boolean? | `true` | 记请求 body |
| `includeResponseBody` | boolean? | `true` | 记响应 body |
| `maxBodyBytes` | number? | `262144` (256KB) | 单 body 上限，超出截断 |
| `maxRecords` | number? | `500` | 总 records 上限，达到自动 stop |
| `captureWebSocketFrames` | boolean? | `true` | 记 WS 收发的 text/binary frame |
| `maxFrameBytes` | number? | `32768` (32KB) | 单 WS frame 上限 |
| `timeoutMs` | number? | `300000` (5min) | 防忘 stop，到时间自动 stop |

**输出**

```ts
{
  recordingId: string;     // uuid，用于后续 stop 调用
  tabId: number;
  url: string;             // tab 当前 url
  startedAt: number;       // ms since epoch
}
```

### 4.2 `browser_stop_record_network`

**输入**

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `recordingId` | string | — | start 返回的 ID |
| `flushDelayMs` | number? | `500` | detach 前等多久让 in-flight 完成 |
| `format` | `'json' \| 'har'?` | `'json'` | 输出格式 |

**输出**

```ts
{
  records: NetworkRecord[];          // format='json' 时
  har?: HAR;                         // format='har' 时（标准 HAR 1.2 结构）
  truncated: boolean;                // 是否触顶 maxRecords
  durationMs: number;
  recordCount: number;
  endedReason: 'user_stop' | 'max_records' | 'timeout' | 'tab_closed' | 'wake_recovery';
  tabId: number;
}
```

`format='har'` 时 `records` 仍存在（双输出），方便 client 选用。

### 4.3 `NetworkRecord` 形态

```ts
interface NetworkRecord {
  requestId: string;                 // CDP 内部 id
  url: string;
  method: string;
  resourceType: 'xhr' | 'fetch' | 'document' | 'script' | 'stylesheet'
              | 'image' | 'media' | 'font' | 'websocket' | 'other';

  requestHeaders?: Record<string, string>;
  requestPostData?: string;
  requestPostDataTruncated?: boolean;

  responseStatus?: number;
  responseStatusText?: string;
  responseHeaders?: Record<string, string>;
  responseMimeType?: string;
  responseBody?: string;             // base64 if binary，UTF-8 string 否则
  responseBodyEncoding?: 'utf8' | 'base64';
  responseBodyTruncated?: boolean;

  failed?: boolean;
  errorText?: string;
  fromCache?: boolean;
  fromServiceWorker?: boolean;

  timing: {
    startTime: number;               // ms since epoch
    endTime?: number;
    durationMs?: number;
    dnsMs?: number;
    connectMs?: number;
    sslMs?: number;
    sendMs?: number;
    waitMs?: number;
    receiveMs?: number;
  };

  initiator?: {
    type: 'parser' | 'script' | 'preflight' | 'other';
    url?: string;
    lineno?: number;
  };

  // 仅 resourceType='websocket' 且 captureWebSocketFrames=true 时填充
  webSocketFrames?: {
    direction: 'sent' | 'received';
    timestamp: number;
    opcode: number;                  // 1=text, 2=binary, 8=close, 9=ping, 10=pong
    payload: string;                 // opcode=1 直接；opcode=2 用 base64
    truncated?: boolean;
  }[];
}
```

## 5. 数据流

### 5.1 start_record_network

```
mcp → bridge → extension SW
extension SW:
  1. resolve tab（openOrReuse 或 tabs.get），url-guard 校验
  2. cdp.attach(tabId)
  3. Network.enable {
       maxTotalBufferSize: 16 * 1024 * 1024,
       maxResourceBufferSize: 4 * 1024 * 1024,
       maxPostDataSize: maxBodyBytes,
     }
  4. add listeners:
     - Network.requestWillBeSent
     - Network.requestWillBeSentExtraInfo
     - Network.responseReceived
     - Network.responseReceivedExtraInfo
     - Network.loadingFinished
     - Network.loadingFailed
     - Network.webSocketCreated (if captureWebSocketFrames)
     - Network.webSocketFrameSent (if captureWebSocketFrames)
     - Network.webSocketFrameReceived (if captureWebSocketFrames)
     - Network.webSocketClosed
  5. registry[recordingId] = {
       tabId, session, buffer: Map<requestId, NetworkRecord>,
       options, timeoutId, keepaliveRef,
       startedAt: Date.now(),
     }
  6. setTimeout(autoStop, timeoutMs)
  7. keepalive ref+1
  8. tab onRemoved listener: 关 tab → autoStop with reason='tab_closed'
return { recordingId, tabId, url, startedAt }
```

### 5.2 在录制期间

```
events 进入 → handler 按 requestId 累积到 buffer:
  - requestWillBeSent: 创建 record，填 url/method/headers/postData/initiator/timing.startTime
  - responseReceived: 填 status/responseHeaders/mimeType/timing 部分
  - loadingFinished: 调 Network.getResponseBody → 填 responseBody（按 maxBodyBytes 截断）
  - loadingFailed: 标 failed=true, errorText
  - webSocketFrameSent/Received: append 到 record.webSocketFrames（按 maxFrameBytes 截断）

filter 检查（在 requestWillBeSent 时）：
  - resourceType ∉ resourceTypes && resourceTypes != ['*']: 不创建 record
  - urlPattern 不命中: 不创建 record
  - buffer.size >= maxRecords: 不创建 record + 触发 autoStop with 'max_records'
```

### 5.3 stop_record_network

```
mcp → bridge → extension SW
extension SW:
  1. registry[recordingId] 找；找不到返 'recording_not_found'
  2. await sleep(flushDelayMs)  // 让 in-flight loadingFinished 进 buffer
  3. cdp.detach(session)
  4. clearTimeout(timeoutId)
  5. keepalive ref-1
  6. records = Array.from(buffer.values()).sort by timing.startTime
  7. if format='har': har = transformToHAR(records)
  8. delete registry[recordingId]
  9. return { records, har?, truncated, durationMs, recordCount, endedReason }
```

### 5.4 autoStop 路径

由 max_records / timeout / tab_closed / wake_recovery 触发：
- 跟 stop_record_network 一样的清理序列：detach CDP、clear timer、keepalive ref-1
- registry[recordingId].state 改成 `'ended'` （**不删 entry**），保留 buffer + endedReason
- 后续 stop_record_network 调用：从 ended state 拿数据返回，**返回完成后才 delete entry**
- 如果 client 永不调 stop，ended entry 在 `2 * timeoutMs` 后被 GC 协程删除（防止 memory leak）

## 6. SW evict 防御

MV3 SW 默认 30s idle 后被回收，长跑 recording 期间必须存活：

- **复用 `lib/keepalive.ts`** (refcounted `chrome.power.requestKeepAwake`)：start 时 +1，stop/autoStop 时 -1
- **额外保险**：start 后开 `chrome.alarms` 每 25s noop 触发，延 SW 寿命
- **极端情况**（用户系统休眠或 SW 真被 evict）：registry 丢，后续 stop 返 `recording_not_found`。文档明确"长跑 ≥ 30min 不保证"。
- **不做**：用 `chrome.storage.session` 持久化 registry 元数据。原因：events 太大不持久化，仅持元数据收益有限（用户拿不到 records，只能区分 "曾经存在" vs "从未存在"），不值得复杂度。v0.3 视实际反馈再加。

## 7. HAR 转换

`format='har'` 时把 records 转成 HAR 1.2 结构：

```ts
{
  log: {
    version: '1.2',
    creator: { name: 'byob', version: '0.2.0' },
    pages: [],                       // 空数组（byob 录制不分页）
    entries: records.map(toHAREntry),
  }
}
```

`toHAREntry`：标准映射，body 用 `text` 字段，binary 加 `encoding: 'base64'`。

WebSocket 在 HAR 1.2 标准里没原生 schema → 加自定义扩展字段 `_webSocketMessages: WebSocketFrame[]`，挂在对应 entry 的 `_resourceType: 'websocket'` 旁。client 自行处理（chrome devtools 也用类似 `_webSocketMessages` 命名）。

实现：`packages/extension/lib/har-converter.ts`。

## 8. 改动文件清单

| 文件 | 改动 |
|---|---|
| `shared/src/commands.ts` | `START_RECORD_NETWORK`, `STOP_RECORD_NETWORK` |
| `shared/src/schemas.ts` | 输入/输出 schemas + `NetworkRecord` + `WebSocketFrame` + `HAR` 类型 |
| `shared/src/errors.ts` | `recording_not_found`, `recording_failed_to_attach` |
| `packages/mcp-server/src/tools/start-record-network.ts` | 注册 |
| `packages/mcp-server/src/tools/stop-record-network.ts` | 注册 |
| `packages/bridge/src/main.ts` | 2 routes |
| `packages/extension/lib/handlers/start-record-network.ts` | 新 |
| `packages/extension/lib/handlers/stop-record-network.ts` | 新 |
| `packages/extension/lib/recording-registry.ts` | 新（in-flight recording state） |
| `packages/extension/lib/network-events.ts` | 新（CDP events → NetworkRecord 累积） |
| `packages/extension/lib/har-converter.ts` | 新（NetworkRecord → HAR 1.2） |
| `packages/extension/lib/keepalive.ts` | 复用 |

## 9. 错误处理

| 场景 | error code | 来源 |
|---|---|---|
| URL 命中 FORBIDDEN_PROTOCOLS | `forbidden_url` | url-guard |
| 既无 url 又无 tabId | `bad_input` | shared schema |
| tabId 不存在 / 已关 | `tab_not_found` | tab.ts |
| CDP attach 失败 | `cdp_attach_failed` | cdp.ts |
| `Network.enable` 失败 | `recording_failed_to_attach` | start handler |
| recordingId 在 stop 时不存在 | `recording_not_found` | stop handler |
| `Network.getResponseBody` 失败（如 streaming） | 跳过 body，标 record.failed？否，record 保留但 responseBody 缺失，不报全局错 | network-events |
| 总 buffer 序列化超 NM 64MB 限 | 截尾 records，标 `truncated:true`，加 warning 字段 | stop handler |

## 10. 测试 / 验收

`docs/e2e-checklist.md` 加：

- [ ] start on `https://news.ycombinator.com` → 浏览 30s → stop → 验证抓到至少 5 条 XHR/fetch
- [ ] start `urlPattern:'*api*'` → 浏览 → stop → 验证只含 url 含 'api' 的
- [ ] start `resourceTypes:['*']` → 验证 document / script / image 都抓到
- [ ] start with `maxRecords:5` → 浏览触发 ≥10 请求 → 验证 records.length=5 + truncated=true + endedReason='max_records'
- [ ] start 后关闭 tab → stop → 验证 endedReason='tab_closed'
- [ ] start 后等 timeoutMs → stop → 验证 endedReason='timeout'
- [ ] start on `wss://echo.websocket.events` → 发收消息 → stop → 验证 record.webSocketFrames 含 sent/received
- [ ] stop with `format:'har'` → 验证 HAR JSON 合法（structure check：`log.entries` 存在，每 entry 有 `request/response/timings`）
- [ ] start + browser_eval `fetch('/api/x')` → stop → 验证 record.responseBody 含 fetch 返的 body

## 11. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| SW 被 evict 导致 registry 丢 | stop 时 `recording_not_found` | keepalive + 25s alarm 双保险；长跑 ≥30min 文档明确"不保证" |
| `getResponseBody` 在 streaming response 上挂起 | stop 卡住 | 单 record body fetch 加 5s timeout，超时跳过 body 但保留 record metadata |
| 大 buffer NM 序列化慢 | stop 返回延迟 3-5s | 接受，文档注明；后续可切 loopback HTTP（沿用 download_images 路径） |
| `Network.enable` 影响 page 性能 | 重 SPA 站略慢 | 已知 trade-off，spec 说明 |
| 录制大量 media stream | buffer 暴涨 | maxBodyBytes 默认 256KB；resourceTypes 默认排除 media |
| HAR 严格 validator 校验失败（自定义字段） | client 用 har-validator 报错 | 文档说明 _webSocketMessages 是 Chrome DevTools 同款扩展，主流工具兼容 |
| WS 大量小 frame（聊天 / 行情）爆 buffer | OOM | maxFrameBytes 单条限 32KB；frame 总数到 maxRecords*10 时停 frame 录制（保 record metadata） |

## 12. 不在范围（v0.3+）

- 实时 streaming events 上报 client（需扩 bridge 协议跨多层抽象，应单独 spec）
- recording 期间动态改 filter（stop + restart 等价更简单）
- HTTP request mocking / interception（Network domain 不同 surface）
- SSL 证书 / cipher 详情
- recording 跨 tab 同时录（按用户撞到再加）

---

**审核签收**：用户确认本 spec 后进入 writing-plans。
