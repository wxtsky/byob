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
