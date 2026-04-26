# Changelog

**English** · [中文](CHANGELOG.zh-CN.md)

---

All notable changes to byob will be documented here.

## [0.3.2] — 2026-04-27

### Added — Batch 3: 3 complex browser tools / 4 MCP tools (29 → 32)

- **`browser_intercept_start`** + **`browser_intercept_stop`** — Stateful
  request interception via CDP `Fetch` domain. Rules array with `urlPattern`
  (glob) or `urlRegex`, optional `methods` filter, and one of 5 actions:
  `block` / `fulfill` / `modify` (request) / `modifyResponse` / `passthrough`.
  `modifyResponse` supports `bodyReplace` (whole-body) or `bodyRegex` (in-place
  regex substitution) — text-like Content-Types only. Mirrors `record-network`'s
  stateful lifecycle (start returns `interceptId`; stop returns hit stats).
- **`browser_drag`** — Mouse drag from one point to another over `durationMs`
  with linear interpolation in `steps` substeps. `from` / `to` each accept a
  CSS selector OR `{x, y}` page coordinates. Triggers mouse events; HTML5
  `dragstart`/`drag`/`dragend` are NOT fired. Supports iframe (`framePath`).
- **`browser_emulate_device`** — Emulate viewport / DPR / touch / User-Agent
  via CDP `Emulation.*Override`. Presets: `iphone-17-pro-max`, `iphone-17`,
  `ipad-pro`, `pixel-9-pro`, `galaxy-s25-ultra`, `desktop` (resets). Or
  `custom: { width, height, deviceScaleFactor, mobile, userAgent? }`. Effect
  persists until reset or tab close.

### Added — error codes

- `intercept_not_found` — `intercept_stop` interceptId is unknown or already drained.

## [0.3.1] — 2026-04-26

### Added — Batch 2: 5 medium-complexity browser tools (24 → 29)

- **`browser_set_cookies`** — Write a cookie via `chrome.cookies.set` (counterpart
  to `browser_get_cookies`). Honors CHIPS partition keys and lowercase `sameSite`
  enum.
- **`browser_print_pdf`** — Save the current page as a PDF using CDP
  `Page.printToPDF` with streaming `IO.read`. Default save dir is `~/.byob/pdfs/`.
  Returns a file PATH (not data). Supports A4/Letter/Legal, landscape, page
  ranges, uniform margins, 120-second timeout.
- **`browser_get_storage`** — Read `localStorage` / `sessionStorage` for the
  page's origin. Supports iframe (`framePath`). Truncates over 1MB by default,
  dropping sessionStorage first then trimming localStorage keys lexicographically.
- **`browser_get_performance`** — Page Web Vitals (LCP/CLS/INP/FCP/TTFB) plus
  navigation timing (DCL, load, DNS, TCP, transfer size). Default 3000ms
  sampling window; INP requires real user interaction.
- **`browser_upload_file`** — Upload local files to `<input type="file">` via
  CDP `DOM.setFileInputFiles`. Bridge validates absolute paths and `fs.access`
  before forwarding to Chrome. Auto-fires `input` + `change` events. Supports
  iframe (`framePath`).

### Added — error codes

- `not_a_file_input` — `upload_file` selector is not `<input type="file">`.
- `file_not_found` — `upload_file` path is missing, non-readable, or non-absolute.

---

## [0.3.0] — 2026-04-26

### Added — 8 new tools (total 16 → 24)

- **`browser_scroll`** — scroll to top/bottom, scroll a selector into view, or
  scroll to an absolute Y coordinate. Returns final `scrollY` + `pageHeight`.
- **`browser_press_key`** — send a single keyboard event (Enter, Escape, Tab,
  F5, ArrowDown, etc.) with optional Alt/Control/Shift/Meta modifiers.
- **`browser_select`** — choose an `<option>` in a native `<select>` by value,
  label, or index. Dispatches `input` + `change` events so SPA frameworks
  pick it up.
- **`browser_close_tab`** — close a browser tab by tabId.
- **`browser_go_back` / `browser_go_forward`** — walk the tab's history one
  step in either direction. Returns `no_history` when the stack is empty.
- **`browser_hover`** — move the mouse over a selector via real CDP mouse
  events. Triggers tooltips and `:hover` dropdown menus.
- **`browser_get_html`** — return outerHTML (or innerHTML) of an element
  (or the whole document). Truncated to `maxBytes` (default 256 KB, max 8 MB)
  on a UTF-8 boundary.

### Added — error codes

- `option_not_found` — `<select>` has no matching `<option>` for the given
  value/label/index (used by `browser_select`).
- `no_history` — the tab's history stack has nothing to go back/forward to
  (used by `browser_go_back` / `browser_go_forward`).

### Added — internals

- 8 new schema unit tests covering required-field, XOR refinements, and
  default values for each new Input schema.

---

## [0.2.0] — 2026-04-25

### Added — 5 new tools (total 11 → 16)

- **`browser_get_console_logs`** — snapshot a tab's `console.log/warn/error`
  + uncaught exceptions via CDP `Runtime.consoleAPICalled` + `Runtime.exceptionThrown`.
- **`browser_read_markdown`** — page → clean markdown via Mozilla Readability +
  turndown. Conversion runs server-side in the bridge (jsdom) so the page
  itself never sees Readability's DOM.
- **`browser_extract_table`** — `<table>` → JSON. Two output shapes
  (`rows` for raw arrays, `objects` keyed by header text) and a
  `nthOfType` selector hint per table.
- **`browser_start_record_network` / `browser_stop_record_network`** — paired
  tools for HTTP + WebSocket capture. Output as JSON or HAR 1.2 (DevTools-
  compatible). Backed by a CDP `Network.*` accumulator with URL-pattern
  filtering and SW-eviction defence.

### Added — iframe support (the D track)

- **`framePath: string[]` parameter on 9 tools** —
  `browser_read / click / type / eval / wait_for / download_images / get_console_logs / read_markdown / extract_table`.
  Walks nested iframes by CSS selector at each level.
- **Cross-origin iframes (OOPIFs) work** via CDP
  `Target.setAutoAttach({ flatten: true })` — the extension transparently
  follows the auto-attached child sessions.
- **Page-level coordinate translation** for clicks inside nested iframes
  (frame-coords helper composes per-frame `getBoundingClientRect`).
- **4 new error codes**: `frame_not_found`, `frame_navigation_during_op`,
  `frame_attach_failed`, `frame_eval_blocked` — each carries
  `framePathIndex` + `reason` so the LLM knows exactly which hop failed.

### Added — cancel chain (the B.1 track)

- **End-to-end cancellation** — mcp-client `Ctrl+C` → bridge
  `POST /cancel` → Native Messaging cancel frame → handler `AbortSignal` →
  CDP detach. Pending `bridgePost` / `bridgeGet` promises reject with the
  new `ABORTED` error code instead of hanging until the 10-min cap.
- Per-call `requestId` is now plumbed through every layer, and every
  handler accepts an `AbortSignal`.

### Added — CDP fallback (the B.2 track)

- **`browser_eval` retries via `chrome.scripting.executeScript`** when CDP
  attach fails (e.g. DevTools is open on the tab). The fallback runs in
  the page world, returns the same shape, and sets
  `_meta.fallbackUsed: true` so callers can tell.

### Added — wake/sleep recovery (the B.3 track)

- **Dual detector** — `chrome.alarms` periodic tick + `chrome.idle` state
  change. On wake, in-flight recordings are aborted and every CDP session
  is detached so the next call starts clean.
- New `ABORTED_DUE_TO_WAKE` error code distinguishes wake-aborts from
  user `Ctrl+C`.

### Added — internals

- **70+ new unit tests** across schema, frame-resolver, har-converter,
  url-pattern, and handler abort plumbing (was sparse before).
- `nthOfType` selector hint added to `browser_extract_table` output for
  reliable click-by-table follow-ups.

### Fixed

- **`browser_extract_table` implicit-thead detection** — when the first
  `<tr>` is all `<th>` Chrome auto-wraps it in a `<tbody>`; we now treat
  that as the header row instead of returning empty results.
- **bridge GET routes accept `?_requestId=` query** — regression introduced
  by the cancel-chain plumbing (B.2) that broke `browser_list_tabs`
  briefly post-merge.

---

## [0.1.0] — 2026-04-25

### Added — flagship features

- **10 MCP tools** end-to-end: `browser_read`, `browser_screenshot`,
  `browser_click`, `browser_type`, `browser_get_cookies`, `browser_navigate`,
  `browser_wait_for`, `browser_list_tabs`, `browser_switch_tab`, `browser_eval`.
- **Native Messaging round-trip** — bun-workspaces TS monorepo with three
  packages (`@byob/shared` schemas, `@byob/bridge` Native Messaging host,
  `@byob/mcp-server` stdio MCP server) plus a WXT-built MV3 extension.
- **Per-user RSA key** — `byob install` auto-generates `~/.byob/extension-key.pem`
  on first run; `wxt.config.ts` reads it dynamically. Two byob installs on
  different machines get two different extension IDs.
- **One-command setup** — `byob install` does it all: key gen → extension build
  → NM manifest write → next-step instructions.
- **Multi-bridge support** — one `byob-bridge` process per Chrome profile, all
  registered in `~/.byob/bridges.json` with PID liveness check.
- **Management CLI** — `byob doctor / install / bridges / logs / uninstall`.

### Added — reliability

- **CDP attach 3× retry** with linear backoff (covers DevTools-toggle race).
- **Discarded-tab revival** — if Chrome GC'd a reused tab, reload + waitForLoad
  before attaching.
- **Special-URL pre-check** — catches `chrome://` / `devtools://` / `about://`
  active tabs before CDP attach throws an opaque error; reported as
  `url_forbidden` with an actionable hint.
- **chrome.power.requestKeepAwake('display')** wraps long-running operations
  via a refcounted helper so concurrent calls don't fight each other.
- **beforeunload guard** — installed during `browser_read` so SPAs can't yank
  the DOM out from under the scroll loop.
- **SPA priming + scrollHeight stability** — first-paint scroll + tracked
  scrollHeight stability fixes the "X.com / FB / new-Reddit returns zero
  chunks on round 1" failure mode.
- **bridgePost / bridgeGet timeouts** — undici Agent with explicit 10-min
  cap + clean `bridge_not_running` envelope when bridge is unreachable.
- **NM-protocol envelope strip** — bridge no longer leaks `type` / `requestId`
  fields into the HTTP response.
- **Handler `type` field collision fix** — dispatcher now spreads payload
  before NM-protocol fields so handlers can never shadow `type:'result'`
  (caught when `EvalOutput.type` collided and stalled the pending-request map).
- **Cookie sameSite enum** matches Chrome's lowercase `chrome.cookies` API
  rather than CDP's capitalized `Network.getCookies` form.
- **Focused-window tab placement** — new background tabs land in the user's
  current window (not a stray new one).

### Added — security

- **`browser_eval` is hidden by default**. Set `BYOB_ALLOW_EVAL=1` on the
  MCP server's environment to expose it.
- **URL blacklist** — chrome:/chrome-extension:/about:/devtools:/view-source:/
  file: protocols and major auth hostnames blocked by default.
- **Eval audit log** — every call appended to `~/.byob/eval-audit.log`.
- **Eval rate-limit** — 5 calls per minute per tab (extension-side).
- **Eval Chrome notification** — every call surfaces a system notification.
- **Socket file mode 0600**, `~/.byob/` directory mode 0700, `umask(0o077)`
  enforced in bridge process.

### Documented as deferred — v0.2

- Cancel/Abort propagation (mcp-client cancel → bridge → CDP detach)
- CDP fallback to `chrome.scripting.executeScript`
- `browser_download_images` separate tool (loopback HTTP for large payloads)
- Wake / sleep detection (1s tick, gap > 5s)
- Cross-frame iframe operation (`Page.getFrameTree` + executionContextId)
- Long-operation streaming progress (MCP `setStatus`)
- Container tree structured output
- Session-handle incremental chunk collection
- Chrome Web Store packaging
