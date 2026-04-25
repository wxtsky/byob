# D iframe 跨 frame 支持设计

> **状态**：草案，待用户审核
> **日期**：2026-04-25
> **关联**：v0.1 整体设计 [`2026-04-25-byob-design.md`](2026-04-25-byob-design.md)
> **目标版本**：v0.2

## 1. 概述

让 byob 现有 11 个工具 + A 三件套（共 14 个工具中相关的 9 个）支持选择 iframe 内的元素和内容。核心设计：

- 接口扩展：相关工具加可选参数 `framePath: string[]`，数组顺序代表嵌套层级
- 实现：CDP `Target.setAutoAttach({autoAttach:true, flatten:true})` 自动接管所有 frame；`Page.getFrameTree` + selector 解析 frame 路径；跨 origin OOPIF 透明支持
- 默认行为不变：不传 framePath 时所有工具操作 main frame，向后兼容

## 2. 动机

实际场景三类：
1. **嵌入式支付/认证流程**（Stripe iframe、Google reCAPTCHA、SSO 登录页）—— 用户让 AI 帮忙完成支付/登录，目标按钮 / 输入框在 iframe 内，当前工具够不到
2. **嵌入式编辑器 / 商品配置器**（CodeSandbox、shopify 主题预览、电商配置）—— 主要交互在 iframe 内
3. **iframe 嵌入广告 / 第三方 widget**—— 抓内容时往往要跳过这些 noise（默认抓 main frame 是对的，但偶尔需要明确进入）

HANDOFF 把 iframe 列在 v0.2 deferred "工程量大"，但作为接口扩展属于"现在能做就该做"的范畴。

## 3. 非目标

- 不做 frame 切换的 UX 自动化（如 "AI 自动判断按钮在哪个 frame"）。client 必须显式传 `framePath`
- 不做 frame 内的 frame discovery API（不加 `browser_list_frames`，因为 framePath 用 CSS selector 已能定位）
- 不做 Shadow DOM 跨边界选择（不同问题，单独 spec）
- 不破坏现有 14 个工具不传 framePath 的默认行为

## 4. frame 选择语法

### 4.1 `framePath: string[]`

数组每一项是一个 CSS selector，按顺序代表 frame 嵌套层级：

```ts
framePath: []                                       // main frame（默认，等同不传）
framePath: ['iframe[name="checkout"]']              // 进入主 page 内的 checkout iframe
framePath: ['iframe.outer', 'iframe.inner']         // 进入 outer iframe 内的 inner iframe
framePath: ['iframe[src*="stripe.com"]']            // 按 src 模糊匹配
```

### 4.2 解析规则

- 每个 selector 必须 match 到**至少 1 个** `<iframe>` 或 `<frame>` 元素
- 如果 match 多个，取第一个（`document.querySelector` 行为）
- 在 frame 嵌套层进 selector 时，selector 在该 frame 的 document context 下解析
- 跨 origin iframe 也能通过 selector 进入（CDP flatten 模式自动处理 OOPIF）
- selector 解析失败 → 返 `frame_not_found` 错误，附 framePath 中失败的索引

### 4.3 不支持

- selector 中带 `>>>` deep 选择符（用 framePath 数组分段表达，跨层语义更清晰）
- 跳过 main frame 直接 attach 子 frame（必须从顶层一层层下钻）

> 标准 CSS pseudo-class（如 `iframe:nth-of-type(2)`）由 `querySelector` 原生支持，可用。

## 5. 接口扩展（哪些工具加 framePath）

| 工具 | 加 framePath | 说明 |
|---|---|---|
| `browser_read` | ✓ | 默认 main frame；framePath 进入子 frame |
| `browser_read_markdown` (A) | ✓ | 同上 |
| `browser_extract_table` (A) | ✓ | 同上 |
| `browser_get_console_logs` (A) | ✓ | console 监听绑定到指定 frame 的 Runtime context |
| `browser_click` | ✓ | element 必须在指定 frame 内 |
| `browser_type` | ✓ | 同上 |
| `browser_eval` | ✓ | code 在指定 frame 的 Runtime context 跑 |
| `browser_wait_for` | ✓ | MutationObserver 监听指定 frame 的 document |
| `browser_download_images` | ✓ | 默认抓 main frame；进 framePath 抓子 frame |
| `browser_screenshot` | — | 本就截整 page 含 iframe，不需要扩展 |
| `browser_navigate` | — | page 级操作 |
| `browser_list_tabs` / `browser_switch_tab` | — | tab 级 |
| `browser_get_cookies` | — | tab 级 |
| `browser_record_network` (C) | — | tab 级（CDP Network domain 已自动覆盖 iframe 请求） |

共 9 个工具加 framePath。其它 6 个不变。

### 5.1 输入扩展示例

```ts
// browser_click 现有 schema:
{
  url?: string; tabId?: number;
  selector: string;
}

// 扩展后:
{
  url?: string; tabId?: number;
  selector: string;
  framePath?: string[];        // 新增
}
```

所有 9 个工具同样的扩展，schema 抽 `FramePathInput` mixin 复用。

### 5.2 输出扩展

不动现有输出。错误情况下加 frame_not_found error code（见 9 节）。

## 6. 实现

### 6.1 `lib/frame-resolver.ts`（新）

核心函数：

```ts
interface ResolvedFrame {
  frameId: string;             // CDP frameId
  contextId: number;           // Runtime.executionContextId for evaluate
  sessionId?: string;          // 跨 OOPIF 时是子 target 的 sessionId
}

async function resolveFrame(
  session: CDPSession,
  framePath: string[],
): Promise<ResolvedFrame>
```

实现步骤：
1. `Page.getFrameTree` 拿主 page 的 frame tree
2. 当前 frame = main frame
3. 对 framePath 每一项 selector：
   - 在当前 frame 的 Runtime context 跑 `document.querySelector(selector)` 拿 element
   - 检查 element 是 `<iframe>` 或 `<frame>`，否则抛错
   - 拿 `element.contentDocument` 不可用（跨 origin），改用 CDP `DOM.describeNode` 拿 frameId of the iframe element
   - 用 `Page.getFrameTree` 在 children 里找 frameId 对应的 frame node
   - 该 frame 升级为 "当前 frame"
4. 返回最终 frame 的 frameId / contextId / sessionId

### 6.2 CDP attach 改造（`lib/cdp.ts`）

`cdp.attach()` 调用时增加：

```ts
await session.send('Target.setAutoAttach', {
  autoAttach: true,
  waitForDebuggerOnStart: false,
  flatten: true,                     // 关键
});
```

flatten 模式效果：
- 主 page 的 CDPSession 自动接管所有 child frame（含 OOPIF）
- 跨 origin 的 OOPIF 也能用同一个 session 寻址（通过 sessionId 区分子 target）
- 事件附带 sessionId，handler 能区分来源

### 6.3 handler 改造模式

每个 frame-aware handler 共用模板：

```ts
export async function handleSomething(params, signal) {
  const tabId = await resolveTab(params);
  const session = await cdp.attach(tabId, { signal });
  try {
    const frame = await resolveFrame(session, params.framePath ?? []);
    // 用 frame.contextId 跑 Runtime.evaluate
    const result = await session.send('Runtime.evaluate', {
      contextId: frame.contextId,
      expression: '...',
      returnByValue: true,
    });
    // 或 sessionId 寻址（OOPIF）
    return processResult(result);
  } finally {
    session.detach();
  }
}
```

### 6.4 click / type 跨 frame 坐标处理

CDP `Input.dispatchMouseEvent` 是 **page-level** API，坐标必须是 page 全局坐标。在 iframe 内 element 的 `getBoundingClientRect()` 是 frame 内坐标，需要转换。

转换流程（封在 `lib/frame-coords.ts`）：

```ts
async function toPageCoords(
  session: CDPSession,
  framePath: string[],
  elementRect: DOMRect,
): Promise<{ x: number, y: number }> {
  // 累加每一层 iframe 元素自身的 boundingClientRect.x/y（在父 frame 内的坐标）
  let offsetX = 0, offsetY = 0;
  let currentFrame = mainFrame;
  for (const selector of framePath) {
    const iframeEl = await querySelectorInFrame(session, currentFrame, selector);
    const rect = await getBoundingRectInFrame(session, currentFrame, iframeEl);
    offsetX += rect.x;
    offsetY += rect.y;
    currentFrame = await frameForIframe(iframeEl);
  }
  return {
    x: offsetX + elementRect.x + elementRect.width / 2,
    y: offsetY + elementRect.y + elementRect.height / 2,
  };
}
```

注意：iframe 自身在父 frame 内可能 transform / scale，CDP 的 boundingRect 已是 transformed coordinate，所以直接累加是对的。极端 CSS（rotate）下不准确，spec 接受这个限制。

### 6.5 eval / wait_for / get_console_logs 改造

不需要坐标转换，只需要 `contextId` 寻址：

- `eval`: `Runtime.evaluate({contextId})` 在指定 frame 跑
- `wait_for`: `Runtime.evaluate({contextId})` 在 frame 里启 MutationObserver；observer 用 `Runtime.addBinding` 回调到 ext
- `get_console_logs`: `Runtime.enable` 是按 session（不是 frame）启用的；过滤 events 时 check `executionContextId` 跟 frame.contextId 是否匹配；OOPIF 跨 sessionId 也按同样规则

## 7. 改动文件清单

| 文件 | 改动 |
|---|---|
| `shared/src/schemas.ts` | 9 个工具 input schema 加可选 `framePath: string[]`；抽 `FramePathInput` mixin |
| `shared/src/errors.ts` | 加 `frame_not_found`（含 framePath 失败索引）、`frame_navigation_during_op`（罕见，frame 中途消失） |
| `packages/extension/lib/frame-resolver.ts` | 新 |
| `packages/extension/lib/frame-coords.ts` | 新（坐标转换） |
| `packages/extension/lib/cdp.ts` | attach 时启 `Target.setAutoAttach flatten` |
| `packages/extension/lib/handlers/read.ts` | 加 framePath；`Runtime.evaluate` 用 frame contextId |
| `packages/extension/lib/handlers/read-markdown.ts` (A) | 同上：抓 frame 内 outerHTML |
| `packages/extension/lib/handlers/extract-table.ts` (A) | 同上：在 frame 内 querySelectorAll |
| `packages/extension/lib/handlers/get-console-logs.ts` (A) | 监听后过滤 executionContextId |
| `packages/extension/lib/handlers/click.ts` | 加 framePath；坐标转换 |
| `packages/extension/lib/handlers/type.ts` | 同上 |
| `packages/extension/lib/handlers/eval.ts` | 加 framePath；contextId 寻址 |
| `packages/extension/lib/handlers/wait-for.ts` | 加 framePath；observer 在 frame |
| `packages/extension/lib/handlers/download-images.ts` | 加 framePath；frame 内枚举 `<img>` |

## 8. 兼容性

- **A 三件套 + D 同 v0.2 发布**：A spec 不变，但 read_markdown / extract_table / get_console_logs 的最终落地代码会一并加 framePath（A spec 写在前没列，但实施时纳入）
- **B 稳定性**与 D 正交：Cancel/CDP fallback/Wake 的实现都可以**先不感知** framePath，把 D 改造视为 handler 内部细节。两个 spec implement 顺序不强求
- **不破坏 v0.1 客户端**：framePath 是可选字段，旧 client 不传等同 main frame

## 9. 错误处理

| 场景 | error code | 触发 |
|---|---|---|
| framePath[i] selector 0 命中 | `frame_not_found` (附 i) | resolveFrame |
| framePath[i] match 到非 iframe 元素 | `frame_not_found` (附 i, reason: 'not_an_iframe') | resolveFrame |
| 跨 origin iframe attach 失败（极少） | `frame_attach_failed` | CDP autoAttach |
| frame 在 op 中途消失（page 删了 iframe） | `frame_navigation_during_op` | Runtime.evaluate 抛 |
| iframe 在 about:blank（没 src） | `frame_not_found` (reason: 'frame_blank') | resolveFrame |
| flatten attach 在 Chrome < 78 | `cdp_attach_failed` (reason: 'flatten_unsupported') | cdp.ts |

## 10. 测试 / 验收

`docs/e2e-checklist.md` 加：

### 单层 iframe
- [ ] 在 https://www.w3schools.com/html/html_iframe.asp（iframe demo 页）：`browser_read framePath:['iframe[name="iframe_a"]']` 验证抓到 iframe 内文字
- [ ] 在同页面：`browser_eval code:'document.title' framePath:['iframe[name="iframe_a"]']` 验证返 iframe 内 document.title

### 嵌套 iframe
- [ ] 构造测试 page（main → iframe → iframe），3 层结构：`framePath:['iframe.outer', 'iframe.inner']` 验证能进最里层

### 跨 origin OOPIF
- [ ] 在含 stripe iframe 的 demo page：`framePath:['iframe[src*="stripe"]']` 抓内容验证 OOPIF 自动 attach 工作

### click 跨 frame 坐标
- [ ] 构造 main 内嵌 iframe，iframe 内 button：`framePath:['iframe.target'] selector:'button#go'` 验证点中 + 触发 button 的 click handler

### 错误路径
- [ ] `framePath:['#nonexistent']` → 验证返 `frame_not_found` with index 0
- [ ] `framePath:['div.foo']` (match div 不是 iframe) → 返 `frame_not_found` reason 'not_an_iframe'

## 11. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| Chrome flatten 模式 OOPIF 处理偶发不稳 | 跨 origin iframe 取不到 contextId | 重试一次；失败标 `frame_attach_failed` 让 client 兜底 |
| iframe 内的 SPA 频繁重渲染 | resolveFrame 拿到的 contextId 后续操作时已失效 | 每次 op 都重 resolve；不缓存 contextId |
| iframe rotate/scale CSS 让坐标转换失准 | click 错位 | 接受限制，spec 注明；极端场景用 eval 直接调 element.click() 兜底 |
| sandbox iframe (sandbox="" without allow-scripts) | eval 注入失败 | 返 `frame_eval_blocked`，文档说明 sandbox 限制 |
| iframe 的 CSP 拒绝注入（如 chrome.scripting 在 OOPIF 上） | extract_table 在 OOPIF 失败 | OOPIF 优先走 CDP `Runtime.evaluate`，不用 chrome.scripting |
| flatten + Cancel 交互：abort 时多 sessionId 都要 detach | detach 不彻底 | abort 时 `Target.detachTarget` for each sessionId |
| 9 个 handler 都要改可能漏 | 行为不一致 | 抽 `FrameAwareHandler` 模板函数，每个 handler 通过模板注入；e2e checklist 逐个跑 |

## 12. 不在范围（v0.3+）

- Shadow DOM 跨边界选择（不同问题）
- frame 自动 discovery API（`browser_list_frames`）
- frame 切换 UX 自动化（"AI 自己找 frame"）
- frame name 直接寻址（如 `targetFrame: 'checkout'` 跳过 framePath 数组）
- frame 内的 service worker / shared worker

---

**审核签收**：用户确认本 spec 后进入 writing-plans。
