# Changelog

**English** · [中文](CHANGELOG.zh-CN.md)

---

All notable changes to byob will be documented here.

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
