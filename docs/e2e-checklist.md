# byob v0.1 e2e Checklist

Run before tagging a release. Each line is one minute or less.

## Link

- [ ] `bun --cwd packages/bridge run dev:cli install --dev` succeeds
- [ ] `byob doctor` all green after extension reload + Chrome restart
- [ ] `curl --unix-socket ~/.byob/bridges/<id>.sock http://x/status` → `{"connected":true}`
- [ ] Kill bridge → confirm extension auto-reconnects within ~3s (extension's exponential backoff)

## Tools (all 10)

- [ ] `browser_read https://news.ycombinator.com` returns story headlines
- [ ] `browser_read https://x.com/anthropic` returns logged-in tweets (cookie reuse proof)
- [ ] `browser_screenshot https://github.com` writes file to `~/.byob/screenshots/<ts>.png`
- [ ] `browser_click textarea[name=q]` on Google home (after navigate)
- [ ] `browser_type "mcp protocol" pressEnter:true` on Google
- [ ] `browser_get_cookies github.com` returns `user_session` (or your authenticated cookie)
- [ ] `browser_navigate` between two domains, reuses tab
- [ ] `browser_wait_for #search` after a Google query → `{found:true, elapsedMs}`
- [ ] `browser_list_tabs` returns all open tabs
- [ ] `browser_switch_tab <id>` activates a chosen tab (window comes to foreground)
- [ ] `BYOB_ALLOW_EVAL=1 browser_eval document.title` returns title + emits notification + audit log line

## Errors

- [ ] `browser_read file:///etc/passwd` → `url_forbidden` envelope
- [ ] DevTools open on tab → `browser_click` returns `cdp_attach_failed` with hint
- [ ] `BYOB_ALLOW_EVAL` unset → `browser_eval` not in `tools/list` (LLM doesn't see it)
- [ ] Tab closed mid-op → `tab_closed` (or graceful failure — depends on which step)
- [ ] Chrome quit mid-call → `bridge_not_running`

## MCP clients

- [ ] Claude Code: `"use byob to ..."` triggers correct tool calls
- [ ] Cursor: same (config in Cursor settings)
- [ ] Cancel mid-call (Ctrl+C) → eventually frees the bridge slot (Phase 6 will do this cleanly)

## Polish

- [ ] `byob bridges` lists 1 process per active Chrome profile
- [ ] `byob logs -f` streams new entries
- [ ] `byob uninstall` removes launcher + all manifests; subsequent `byob doctor` shows `✗`
- [ ] Re-`byob install --dev` → all green again

## v0.2 read-tools trio (sub-project A)

### `browser_get_console_logs`

- [ ] On `https://example.com`, run `browser_eval "console.error('test'); console.warn('w'); throw new Error('boom')"` then `browser_get_console_logs` (same tab) — expect 3 entries: 1× error, 1× warn, 1× exception with stackTrace
- [ ] Same tab, call `browser_get_console_logs level: ['error']` — exception still appears (independent flag), warn does not
- [ ] Same tab, call `browser_get_console_logs level: ['error'] includeExceptions: false` — only the error entry; no exception
- [ ] On `chrome://settings` — expect `url_forbidden` envelope with hint

### `browser_read_markdown`

- [ ] On a BBC News article — markdown contains the headline, lengthChars > 500, byline non-empty, no `<nav>` / footer text
- [ ] On `https://x.com/anthropic` (heavy SPA) — expect either a usable result OR `readability_no_article` envelope with htmlLength field; never crash
- [ ] Same BBC article with `includeImages: false` — markdown contains zero `![` substrings
- [ ] Same BBC article with `maxLength: 200` — markdown ends with `\n\n[truncated]\n`, `truncated: true`

### `browser_extract_table`

- [ ] On `https://en.wikipedia.org/wiki/List_of_countries_by_population_(United_Nations)` with default `selector: 'table'` and `format: 'objects'` — at least one returned table; first row has key names matching first column header (e.g. "Country / Dependency"); rowCount >= 50
- [ ] Same URL with `selector: 'table.sortable'` and `format: 'rows'` — rows are `string[][]` not `Record<string,string>[]`
- [ ] On a page with no tables (e.g. `https://example.com`) — `tables: []`, no error

## record_network (v0.2 sub-project C)

Pre-req: Chrome restarted with the rebuilt extension. `bun run typecheck` green.

- [ ] **Basic XHR capture** — Start `browser_start_record_network` with `url=https://news.ycombinator.com`, browse for ~30 s, then stop. Expect `recordCount >= 5` and at least one entry with `resourceType ∈ {xhr, fetch}` and a populated `responseBody`.
- [ ] **urlPattern glob filter** — Start with `urlPattern='*api*'` on a SPA-heavy page (e.g. `https://github.com/anthropics/anthropic-sdk-typescript`), browse, stop. Verify every record's `url` contains `api`.
- [ ] **resourceTypes=['*']** — Start with `resourceTypes=['*']` on `https://github.com`, stop after 10 s. Verify records of type `document`, `script`, `image`, `stylesheet` are all present.
- [ ] **maxRecords autoStop** — Start with `maxRecords=5`, navigate to a page that fires more than 10 requests, stop. Verify `recordCount=5`, `truncated=true`, `endedReason='max_records'`.
- [ ] **tab_closed autoStop** — Start a recording, then close the tab manually before calling stop. Call stop. Verify `endedReason='tab_closed'` and the records captured before close are returned.
- [ ] **timeout autoStop** — Start with `timeoutMs=5000`, wait 10 s, then stop. Verify `endedReason='timeout'`.
- [ ] **WebSocket frames** — Start on `https://www.websocket.org/echo.html` (or open the dev console on a page and connect to `wss://echo.websocket.events`). Send a few text messages. Stop. Verify exactly one record with `resourceType='websocket'` and `webSocketFrames` containing both `direction='sent'` and `direction='received'` entries.
- [ ] **HAR format** — Stop with `format='har'`. Verify `har.log.version='1.2'`, `har.log.entries.length===recordCount`, every entry has `request.method`, `response.status`, `timings.dns/connect/send/wait/receive` keys.
- [ ] **eval-then-stop** — Start a recording. Use `BYOB_ALLOW_EVAL=1 browser_eval` to run `fetch('/robots.txt').then(r=>r.text())`. Stop. Verify a record exists for `/robots.txt` with `responseBody` populated.
- [ ] **recording_not_found** — Call stop with a random UUID that was never started. Expect MCP error envelope with `error='recording_not_found'`.

## D — iframe / cross-frame addressing (v0.2)

Pre-req: `BYOB_ALLOW_FILE=1` for the local nested fixture; standard env for the others.

### Single-level iframe (same origin)

- [ ] In Chrome, open `https://www.w3schools.com/html/html_iframe.asp`.
- [ ] Run `browser_read framePath:['iframe[name="iframe_a"]']`.
      Expected: response `text` contains "W3Schools" placeholder text from the embedded frame, NOT the surrounding tutorial chrome.
- [ ] Run `browser_eval code:'document.title' framePath:['iframe[name="iframe_a"]']` (with `BYOB_ALLOW_EVAL=1`).
      Expected: `result` equals the inner-frame document title (different from the outer tutorial's title).

### Nested iframe (3 levels)

- [ ] Open `file://<repo-root>/assets/fixtures/iframe-nested.html` in Chrome (replace `<repo-root>` with `pwd` from your byob clone, e.g. `/home/me/byob`). Requires `BYOB_ALLOW_FILE=1`.
- [ ] Run `browser_read framePath:['iframe.outer', 'iframe.inner']`.
      Expected: response `text` contains "inner".
- [ ] Run `browser_click framePath:['iframe.outer', 'iframe.inner'] selector:'#go'`.
- [ ] Run `browser_read framePath:['iframe.outer', 'iframe.inner']` again.
      Expected: response `text` now contains "clicked".

### Cross-origin OOPIF (Stripe demo)

- [ ] Open any page that embeds Stripe Elements. Confirm DevTools shows the Stripe iframe is cross-origin.
- [ ] Run `browser_eval code:'location.host' framePath:['iframe[src*="stripe"]']`.
      Expected: `result` ends with "stripe.com".

### click in iframe — coordinate translation

- [ ] On the local fixture, run `browser_click framePath:['iframe.outer', 'iframe.inner'] selector:'#go'`.
- [ ] Then `browser_eval code:'document.getElementById("mark").textContent' framePath:['iframe.outer', 'iframe.inner']`.
      Expected: `result === "clicked"`.

### Error paths

- [ ] `browser_click framePath:['#nonexistent'] selector:'button'`.
      Expected: response envelope `error: 'frame_not_found'`, `framePathIndex: 0`.
- [ ] `browser_click framePath:['div.foo'] selector:'button'` against a page with a `<div class="foo">`.
      Expected: response `error: 'frame_not_found'`, `framePathIndex: 0`, `reason: 'not_an_iframe'`.
- [ ] `browser_eval framePath:['iframe[sandbox=""]'] code:'1+1'` against a page with `<iframe sandbox="">`.
      Expected: response `error: 'frame_eval_blocked'` with hint mentioning `allow-scripts`.

### Default behavior unchanged

- [ ] `browser_read https://news.ycombinator.com` (no `framePath`).
      Expected: same v0.1 output.
- [ ] `browser_click selector:'#search'` on Google with no `framePath`.
      Expected: same v0.1 click behavior.

## E — v0.2 Stability (Cancel / CDP Fallback / Wake)

### v0.2 — Cancel / Abort

- [ ] Long screenshot cancel
  - In Claude Code (or any MCP client), call: `byob:browser_screenshot { url: "https://www.binance.com", fullPage: true }`
  - After ≥ 1 s but before completion, send Ctrl-C / cancel.
  - Verify all of:
    - MCP client sees an isError envelope with `error: "aborted"` and `aborted: true`.
    - `tail -50 ~/.byob/bridge.log` shows a `cancel: aborting requestId=...` line.
    - Extension service-worker console (chrome://extensions → byob → service worker → Inspect) shows the handler dispatch ended without an unhandled error.
    - Immediately after, a fresh `byob:browser_list_tabs` call succeeds in < 200 ms (no zombie state).

- [ ] Mid-navigation cancel
  - Call `byob:browser_navigate { url: "https://example.com", waitUntil: "load" }`.
  - Cancel before completion.
  - Verify the tab in Chrome is in a usable state (not stuck loading).

- [ ] Cancel of an already-finished request is a no-op
  - Run any quick tool to completion (e.g. `browser_list_tabs`).
  - Manually POST `/cancel` with that requestId via curl:
    ```
    curl -s --unix-socket ~/.byob/bridges/<id>.sock -X POST -H 'Content-Type: application/json' -d '{"requestId":"00000000-0000-0000-0000-000000000000"}' http://localhost/cancel
    ```
  - Verify response is `{ "ok": true }` and bridge log shows `cancel: unknown requestId ... (no-op)`.

### v0.2 — CDP Fallback

- [ ] Eval works immediately after extension reload (DevTools-held simulation)
  - Reload the extension at chrome://extensions.
  - Within 1 s of the reload, call `byob:browser_eval { code: "1+1", tabId: <some open tab> }` (with `BYOB_ALLOW_EVAL=1`).
  - Expected: response succeeds, value === 2, MCP `_meta.fallbackUsed === true`.

- [ ] Steady-state eval uses CDP (no fallback)
  - Wait 5 s after the previous test.
  - Call `byob:browser_eval { code: "1+1", tabId: <same tab> }`.
  - Expected: response succeeds, value === 2, `_meta.fallbackUsed === false`.

- [ ] Fallback path on a special page returns url_forbidden, not fallbackUsed:true
  - `byob:browser_eval { code: "1+1", tabId: <chrome://settings tab> }`.
  - Expected: isError envelope `{ error: "url_forbidden" }`. (Fallback should NOT activate on chrome:// pages.)

### v0.2 — Wake / Sleep Recovery

- [ ] macOS lid-close-and-open with no in-flight call
  - Close laptop lid for ≥ 5 minutes, reopen, unlock.
  - Within 10 s of unlock, run `byob:browser_read https://news.ycombinator.com`.
  - Expected: success. Service-worker log shows `[byob/wake-watch] triggered by alarm` or `idle`, plus `aborting in-flight + detachAll`.

- [ ] Lid-close mid-call surfaces aborted_due_to_wake
  - Start a long-running call (e.g. `browser_read` of a 50-screen page with `screens: 50`).
  - Within 5 s, close the lid for ≥ 2 minutes, reopen.
  - Expected: the original MCP call returns isError `{ error: "aborted_due_to_wake", aborted: true }` shortly after wake.

- [ ] Wake recovery is idempotent
  - Sleep+wake the laptop twice in quick succession (e.g. lid close-open-close-open).
  - Expected: no errors; subsequent tool calls succeed.

---

## v0.3 第 1 批 — 8 个简单工具

> 在测试前先重启 Chrome（让新 manifest 生效）+ 重启 MCP server（让 24 个工具被注册）。

### browser_scroll

- [ ] **滚到底部**：`browser_scroll(url='https://example.com', to='bottom')` → 期望 `scrollY > 0`、`pageHeight > 0`
- [ ] **滚到 selector**：在 byob GitHub README 上调 `browser_scroll(tabId=<某个 tabId>, selector='#footer')` → 期望页面滚到 footer，`scrollY` 接近 `pageHeight - viewport`
- [ ] **绝对坐标**：`browser_scroll(tabId=..., y=500)` → 期望 `scrollY === 500`
- [ ] **selector 不存在**：`browser_scroll(tabId=..., selector='#does-not-exist')` → 期望 `error: 'selector_not_found'`

### browser_press_key

- [ ] **回车提交**：先 `browser_navigate('https://www.google.com')` → `browser_click(selector='textarea')` → `browser_type(selector='textarea', text='mcp protocol spec')` → `browser_press_key(tabId=..., key='Enter')` → 验证导航到搜索结果页
- [ ] **GitHub 搜索快捷键**：在 GitHub 任意页面上 `browser_press_key(tabId=..., key='/')` → 期望搜索框 focus（用 `browser_eval` 或 `browser_get_html` 验证 `document.activeElement` 是搜索框）

### browser_select

- [ ] **w3schools select**：在 `https://www.w3schools.com/tags/tryit.asp?filename=tryhtml_select` 演示页 → `browser_select(tabId=..., selector='select', label='Banana')` → 期望 `selectedLabel === 'Banana'`
- [ ] **value 模式**：同页面 `browser_select(tabId=..., selector='select', value='audi')` → 期望 `selectedValue === 'audi'`
- [ ] **option 不存在**：`browser_select(tabId=..., selector='select', value='not-real')` → 期望 `error: 'option_not_found'`

### browser_close_tab

- [ ] **正常关闭**：`browser_list_tabs` 拿到 ID → `browser_close_tab(tabId=<id>)` → 期望 `closed: true` + 后续 `browser_list_tabs` 不再列出该 tab
- [ ] **不存在的 tabId**：`browser_close_tab(tabId=99999999)` → 期望 `error: 'tab_closed'`

### browser_go_back / browser_go_forward

- [ ] **A→B→back**：`browser_navigate('https://example.com')` 拿到 tabId → `browser_navigate(url='https://example.org', tabId=<id>)` → `browser_go_back(tabId=<id>)` → 期望 `url` 是 `example.com`
- [ ] **再 forward**：紧接着 `browser_go_forward(tabId=<id>)` → 期望 `url` 是 `example.org`
- [ ] **没有可后退**：开新 tab 后立刻 `browser_go_back(tabId=<id>)` → 期望 `error: 'no_history'`

### browser_hover

- [ ] **下拉菜单展开**：在 GitHub 任一页面 → `browser_hover(tabId=..., selector='button[aria-label*="Open user navigation menu"]')` → 接 `browser_wait_for(tabId=..., selector='[data-testid="signed-in-user-menu"]')` → 期望菜单出现

### browser_get_html

- [ ] **整页**：`browser_get_html(url='https://example.com')` → 期望 `html` 包含 `<h1>Example Domain</h1>`、`truncated: false`
- [ ] **selector**：同上 + `selector='h1'` → 期望 `html === '<h1>Example Domain</h1>'`
- [ ] **innerHtml**：同上 + `selector='h1'`、`outerHtml=false` → 期望 `html === 'Example Domain'`
- [ ] **截断**：在大页面（比如 `https://en.wikipedia.org/wiki/List_of_countries_by_population_(United_Nations)`）上 `browser_get_html(url=..., maxBytes=1024)` → 期望 `truncated: true`、`byteLength <= 1024`

---

## v0.3 第 2 批 — 5 个中等复杂度工具

> 在测试前先重启 Chrome（让新 manifest 生效）+ 重启 MCP server（让 29 个工具被注册）。

### browser_set_cookies

- [ ] set 一条 `name='byob-test'`, `value='1'`, `url='https://example.com'`，再 `get_cookies({domain:'example.com'})`，验证读到 byob-test=1
- [ ] set 一条带 `expirationDate=Math.floor(Date.now()/1000)+3600`，验证 1 小时后过期
- [ ] set 一条 `sameSite:'lax'`（小写）验证写入；试 `sameSite:'Lax'`（大写）验证 schema 拒绝

### browser_print_pdf

- [ ] 打 example.com → PDF，验证 `~/.byob/pdfs/<ts>.pdf` 存在且 byteLength > 0；用 `open` 打开能正确显示
- [ ] 同一页 `landscape:true`，验证 PDF 是横向
- [ ] 长页面（GitHub 某 README）`pageRanges:'1-2'`，验证只 2 页
- [ ] 自定义 `savePath:'/tmp/byob-pdf-test.pdf'` 验证按指定位置写盘

### browser_get_storage

- [ ] 在 example.com 上先 `eval` 写一些 localStorage（`localStorage.setItem('a','1')`），再 `get_storage` `kind:'local'`，验证读到 `{ a: '1' }`
- [ ] `kind:'both'`，验证返 `localStorage` 和 `sessionStorage` 两个字段
- [ ] 写 >1MB 的 localStorage（用 eval 写一个大 string），get 时验证 `truncated:true`

### browser_get_performance

- [ ] 在 example.com 调，验证 navigation 字段都有值，FCP 有值
- [ ] 在 SPA（如 google.com）上点几下后再调，验证 INP 有值
- [ ] 在新 tab 直接调，验证 INP=null，CLS=null（无累积）
- [ ] `waitMs:0` 调一次（瞬读），验证仍能返回，且 LCP 可能 null

### browser_upload_file

- [ ] 准备一个本机文件 `/tmp/byob-test.txt`，在 https://www.w3schools.com/tags/tryit.asp?filename=tryhtml5_input_type_file 之类的演示页上传，验证 `input.files.length === 1`
- [ ] 多文件：`paths:['/tmp/a.txt','/tmp/b.txt']`，input 的 `multiple` 属性下验证读到 2 个
- [ ] 文件不存在：`paths:['/tmp/nonexistent']`，验证 `file_not_found`
- [ ] 非绝对路径：`paths:['./relative.txt']`，验证 `file_not_found`（错误信息说 "not absolute"）
- [ ] selector 不是 file input：传 `<input type="text">`，验证 `not_a_file_input`
