# A 三件套（read tools trio）设计

> **状态**：草案，待用户审核
> **日期**：2026-04-25
> **关联**：v0.1 整体设计 [`2026-04-25-byob-design.md`](2026-04-25-byob-design.md)
> **目标版本**：v0.2

## 1. 概述

在 byob 现有 11 个 MCP 工具基础上，加 3 个"读取页面信息"类工具：

| 工具 | 一句话 |
|---|---|
| `browser_get_console_logs` | 抓 page 的 console 输出和 JS 异常 |
| `browser_read_markdown` | 把 page 主体内容转成干净 markdown（剥导航/广告） |
| `browser_extract_table` | 把 page 上的 `<table>` 抽成 JSON |

3 个工具共享接口风格、错误处理、tab 解析逻辑，因此合一份 spec。

## 2. 动机 (Motivation)

现有 `browser_read` 返回的是经过简单清洗的 page 文字。够用，但有 3 个真实场景覆盖不到：

1. **调试 bug** — 用户改完前端，让 AI 去 page 看 console 有没有报错。当前没工具能拿 console。
2. **结构化抓取** — 用户让 AI 抓某个对比表格的数据。`browser_read` 把表格压成纯文本，行列对应丢失。
3. **聚合阅读** — 用户让 AI 总结一篇新闻。`browser_read` 输出含导航/相关推荐/广告噪音，markdown 干净版本更适合 LLM 二次处理。

3 件套各对应一个场景，组合起来让 byob 从"通用浏览器自动化"升级到"AI 友好的内容提取栈"。

## 3. 非目标 (Non-Goals)

- **不做 streaming / 跨 navigation 长链监听**。`get_console_logs` 是一次性 snapshot，不维护跨页面 session。需要时单独引入 SessionManager（C `record_network` 会做）。
- **不做 inline DOM 选择器交互**。`extract_table` 只抽 `<table>`，不抽 `<div>` 伪表格。要做通用结构化抓取交给将来的 `browser_extract_structured`。
- **不做 PDF / 图像 OCR**。`read_markdown` 只处理 HTML page，PDF / 图像不在范围。

## 4. 接口

所有工具沿用 byob 现有 `urlOrTabId` 二选一模式：传 `url` 则新 tab 打开 + `waitForLoad`；传 `tabId` 则在现有 tab 上操作。

### 4.1 `browser_get_console_logs`

**输入**

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `url` | string? | — | 二选一 |
| `tabId` | number? | — | 二选一 |
| `level` | `('log'\|'info'\|'warn'\|'error'\|'debug')[]?` | `['warn','error']` | 过滤 console API 级别（不含 exception） |
| `includeExceptions` | boolean? | `true` | 是否包含未捕获 JS 异常（独立开关，输出 level 标 `'exception'`） |
| `flushDelayMs` | number? | `200` | attach 后等多久让 events flush（上限 5000） |

**输出**

```ts
{
  logs: {
    level: 'log' | 'info' | 'warn' | 'error' | 'debug' | 'exception';
    text: string;                    // 已 stringify 的 args
    source?: string;                 // 文件 url
    lineno?: number;
    colno?: number;
    timestamp: number;               // ms since epoch
    stackTrace?: string;             // 仅 exception 和 error 带
  }[];
  truncated: boolean;                // CDP buffer 是否已 trim 过老 events
  tabId: number;
  url: string;
}
```

### 4.2 `browser_read_markdown`

**输入**

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `url` | string? | — | 二选一 |
| `tabId` | number? | — | 二选一 |
| `includeMetadata` | boolean? | `true` | 是否附带 title/byline/excerpt |
| `includeImages` | boolean? | `true` | markdown 是否保留 `![alt](url)`；false 时整段过滤 |
| `preserveCode` | boolean? | `true` | 用 turndown `codeBlockStyle: 'fenced'` 输出 ``` 围栏；false 走默认缩进式 |
| `maxLength` | number? | — | markdown 字符数硬截断；触顶时尾部追加 `\n\n[truncated]\n` |

**输出**

```ts
{
  markdown: string;
  title?: string;
  byline?: string;                   // 作者信息（Readability 提取）
  excerpt?: string;                  // 摘要（Readability 提取）
  lengthChars: number;               // 提取后字数（不含格式符号）
  truncated?: boolean;               // 仅当 maxLength 触顶时为 true
  tabId: number;
  url: string;
}
```

### 4.3 `browser_extract_table`

**输入**

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `url` | string? | — | 二选一 |
| `tabId` | number? | — | 二选一 |
| `selector` | string? | `'table'` | CSS 选择器，匹配多个则全部返回 |
| `format` | `'rows' \| 'objects'?` | `'rows'` | rows 二维数组；objects 用首行做 key |

**输出**

```ts
{
  tables: {
    selector: string;                // 实际命中的 selector
    headers: string[];               // 首行（th 优先，否则首个 tr 的 td）
    rows: string[][] | Record<string, string>[];
    rowCount: number;
  }[];
  tabId: number;
  url: string;
}
```

匹配 0 个表格返回 `tables: []`，**不视为错误**。

## 5. 实现

### 5.1 复用现有基础设施

| 模块 | 用法 |
|---|---|
| `lib/tab.ts` `openOrReuse + waitForLoad` | url 模式打开/复用 tab |
| `lib/url-guard.ts` `FORBIDDEN_PROTOCOLS` | url 模式入口 url 校验 |
| `lib/cdp.ts` CDP attach with retry | console_logs 用 |
| `chrome.scripting.executeScript` | extract_table + read_markdown 抓 outerHTML |
| `lib/notify.ts` | 同 eval，notify user 当前操作 |

### 5.2 `browser_get_console_logs` handler

```
packages/extension/lib/handlers/get-console-logs.ts
```

流程：
1. 解析 tab（`openOrReuse` 或 `tabs.get`）
2. `cdp.attach(tabId)` → CDP session
3. `Runtime.enable` → 触发 history replay；监听 `Runtime.consoleAPICalled`、`Runtime.exceptionThrown`
4. `Log.enable` → 监听 `Log.entryAdded`（捕获网络错误、deprecation 等浏览器层日志）
5. 收集 events 到 buffer，按 `level` 过滤
6. 等 `flushDelayMs`（默认 200ms）
7. detach CDP，返回 buffer
8. `truncated` 判定：CDP 不直接报 buffer 满。启发式：CDP 默认 console buffer 上限 1000 条；如果 `Runtime.enable` 后 history replay 数量恰好命中 1000，标 `truncated=true`。注明这是启发式，不一定 100% 准。

**args stringify 策略**：CDP 的 `consoleAPICalled.args` 是 `RemoteObject[]`。用 `Runtime.callFunctionOn` 跑 `JSON.stringify` 不靠谱（循环引用）。简化策略：每个 arg 取 `description || value || className`，join 空格。复杂对象（如 `{a:1}`）会显示成 `Object`，跟 Chrome DevTools 的紧凑显示接近。

### 5.3 `browser_read_markdown` handler 链

```
packages/extension/lib/handlers/read-markdown.ts  → bridge upload-server (新增 /readability route)
```

流程：
1. extension 端：解析 tab → `chrome.scripting.executeScript({ func: () => document.documentElement.outerHTML, world: 'ISOLATED' })`
   - DOM 在两个 world 都共享可见，用 `ISOLATED`（默认）避免被 page 全局变量/CSP 干扰
2. extension 把 outerHTML POST 到 bridge 的 `http://127.0.0.1:<port>/readability`（沿用 `download_images` 走过的 loopback HTTP）
3. bridge 端：用 `jsdom` 构 DOM → `@mozilla/readability` 提取 article → `turndown` 转 markdown
4. bridge 返回 `{ markdown, title, byline, excerpt, lengthChars }`
5. extension 把结果通过 NM 帧返给 bridge → mcp-server

**为什么不直接在 NM 帧返 HTML 让 mcp-server 处理**：mcp-server 是纯 stdio + JSON-RPC，不该带重型 DOM 依赖。bridge 已经是 Node 进程、已经有 upload-server 设施，自然落点。

**HTML 体积**：典型新闻 page outerHTML 几百 KB；极端 SPA（如 Twitter）可能 5-10MB。NM 帧硬限 64MB，够用。如果实测有性能问题，再考虑 gzip 压缩。

### 5.4 `browser_extract_table` handler

```
packages/extension/lib/handlers/extract-table.ts
```

流程：
1. 解析 tab
2. `chrome.scripting.executeScript({ func: extractTablesInPage, args: [selector, format], world: 'ISOLATED' })`（默认，DOM 共享可见）
3. `extractTablesInPage`：
   - `document.querySelectorAll(selector)` 拿到所有匹配 `<table>`
   - 每个 table：
     - `headers`：优先 `thead tr th` → 退到首个 `tr` 的 `td/th`
     - `rows`：剩余 `tr`，每 cell 取 `innerText.trim()`
     - `format='objects'` 时按 `headers` 配对
4. 返回 `tables[]`

**innerText vs textContent**：用 `innerText`（CSS 视觉文本，处理 `display:none`、换行）。如果 page 没渲染（headless 场景） `innerText` 退化为 `textContent`，可接受。

## 6. shared/schemas 改动

```
shared/src/commands.ts:
+ export const GET_CONSOLE_LOGS = 'browser_get_console_logs';
+ export const READ_MARKDOWN = 'browser_read_markdown';
+ export const EXTRACT_TABLE = 'browser_extract_table';

shared/src/schemas.ts:
+ GetConsoleLogsInput / GetConsoleLogsOutput
+ ReadMarkdownInput / ReadMarkdownOutput
+ ExtractTableInput / ExtractTableOutput
```

3 个 input schema 都 `z.union` 一个 `urlOrTabId` 子 schema，复用现有 `OpenInputBase`（如果已有；没有就抽出来）。

## 7. mcp-server 改动

```
packages/mcp-server/src/tools/get-console-logs.ts
packages/mcp-server/src/tools/read-markdown.ts
packages/mcp-server/src/tools/extract-table.ts
```

每个 tool 文件做 `server.tool()` 注册，把 input schema 映射到 bridge route。

## 8. bridge 改动

```
packages/bridge/src/main.ts:
+ 3 个新 route，dispatch 到 NM 帧
+ /readability 内部 HTTP route（upload-server.ts 注册）

packages/bridge/src/readability-server.ts (新):
+ jsdom + @mozilla/readability + turndown 处理
```

新增依赖（bridge 包）：
- `@mozilla/readability` (~30KB)
- `turndown` (~50KB)
- `jsdom` (~3MB 装机)

> **依赖审视**：jsdom 体积大，但 byob bridge 是 Node 进程，安装一次后不影响 runtime 启动速度。备选方案 `linkedom` 体积小 10x 但跟 readability 兼容性偶发差异。**首选 jsdom**，如果实测性能/体积问题再换。

## 9. 错误处理

| 场景 | error code | 说明 |
|---|---|---|
| URL 命中 `FORBIDDEN_PROTOCOLS` | `forbidden_url` | 现有 url-guard 直接抛 |
| 既无 url 也无 tabId | `bad_input` | shared schema 校验时抛 |
| tabId 不存在 / 已关闭 | `tab_not_found` | tab.ts 抛 |
| CDP attach 失败（特殊 url、devtools 占用） | `cdp_attach_failed` | cdp.ts 现有逻辑抛 |
| `read_markdown`：jsdom parse 失败 | `html_parse_failed` | 边界情况，包装抛 |
| `read_markdown`：Readability 没识别出主内容（返 null） | `readability_no_article` | 返结构化错误，附 outerHTML 长度便于调试 |
| `extract_table`：selector 0 命中 | 返 `tables:[]`，**不算错** | |
| `get_console_logs`：handler 中 CDP detach 异常 | log warn，不影响返结果 | |

所有错误走 `shared/errors.ts` 现有 `BridgeError` envelope，mcp-server 端通过 `error-mapper.ts` 转 MCP `isError`。

## 10. 测试 / 验收

不强求单元测试（byob 现有测试覆盖也稀疏）。e2e checklist 加 5 项：

- [ ] `get_console_logs` on `https://example.com`，先 eval `console.error('test'); console.warn('w'); throw new Error('boom')`，验证 3 条都返出，level 正确
- [ ] `get_console_logs` `level: ['error']` 过滤生效
- [ ] `read_markdown` on 一篇 BBC 新闻，验证 markdown 干净、有标题、字数 > 500
- [ ] `read_markdown` on Twitter（重 SPA），验证至少 title 抓到（Readability 可能识别失败也接受）
- [ ] `extract_table` on `https://en.wikipedia.org/wiki/List_of_countries_by_population_(United_Nations)`，验证 `format='objects'` 模式能把"国家"列名为 key

`docs/e2e-checklist.md` 同步更新。

## 11. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| Readability 在 SPA 站偶发识别失败 | `read_markdown` 报 `readability_no_article` | 错误信息包含 outerHTML 长度，让 client 决定是否退到 `browser_read` |
| HTML POST 到 bridge 走 loopback HTTP，部分用户防火墙 | bridge 启动失败 | 沿用 `download_images` 同 server，如果它能跑就这个能跑 |
| jsdom 版本和 readability 不兼容 | bridge 跑不起来 | 锁版本；CI 跑 typecheck + 一次手工 e2e |
| CDP `Log.enable` 在某些 Chrome 版本上不返事件 | console_logs 漏部分浏览器层日志 | 文档注明：主要靠 Runtime API 抓 page console，Log domain 是 best-effort |
| `extract_table` 对 colspan/rowspan 处理简化（直接 innerText join，不展开） | 复杂表格输出畸形 | spec 文档说明此限制；用户需要展开建议预处理 page |

## 12. 不在本 spec 范围（v0.3+ 候选）

- console_logs 的 start/stop 配对模式（决策已定 snapshot，需要时再加）
- extract_table 的 `<div role="table">` ARIA 表格支持（实际场景占比低）
- extract_table 自动展开 colspan/rowspan（rowspan 跨多行的正确实现复杂度对收益不划算）

---

**审核签收**：用户确认本 spec 后进入 writing-plans。
