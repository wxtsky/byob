<div align="center">

<img src="assets/logo.svg" alt="byob" width="120"/>

# byob

**Bring Your Own Browser** — let your AI agent drive the Chrome you're already logged into.

[![License: MIT](https://img.shields.io/badge/license-MIT-22c55e.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-stdio-0a0a0a.svg)](https://modelcontextprotocol.io)
[![Chrome MV3](https://img.shields.io/badge/Chrome-MV3-f59e0b.svg)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![v0.1](https://img.shields.io/badge/v0.1-ready-22c55e.svg)](CHANGELOG.md)

**English** · [中文](README.zh-CN.md)

</div>

---

## What you can actually do with it

> *"use byob to read my Twitter timeline and summarize the top 5 posts"*

byob opens a background tab in your already-logged-in Chrome, scrolls it, returns the rendered DOM. Claude summarises. **Your X session, your reCAPTCHA solves, zero copy-pasting cookies.**

> *"google 'mcp protocol spec', click the first official result, dump the page"*

`browser_navigate` → `browser_type` (Enter) → `browser_wait_for` → `browser_click` → `browser_read`. Five tools chained automatically.

> *"grab my GitHub session cookie so I can curl from a script"*

`browser_get_cookies github.com` returns 19 cookies including `user_session`. Now `curl` works against any private endpoint.

> *"screenshot https://example.com"*

`browser_screenshot` saves a PNG to `~/.byob/screenshots/` and returns the path. No base64 token bloat.

> *"open my Gmail tab and tell me how many unread"*

byob = read pages **with the auth context the cloud headless browsers can't get**.

---

## Why not just `WebFetch` / Puppeteer?

|  | WebFetch | Headless Puppeteer | **byob** |
|---|:-:|:-:|:-:|
| Sees content behind login | ❌ | ⚠️ copy cookies | ✅ your real session |
| Bypasses anti-bot heuristics | ❌ | ❌ | ✅ it's literally your browser |
| Setup time | 0 | hours | **5 min** |
| Costs cloud $ | ✅ | ❌ | ✅ |

---

## 5-minute setup

```sh
git clone https://github.com/<you>/byob ~/code/byob
cd ~/code/byob && bun install
( cd packages/bridge && bun run dev:cli install --dev )      # auto: keygen → build ext → write NM manifests
# → follow on-screen prompt to load packages/extension/.output/chrome-mv3 in chrome://extensions
# → ⌘Q Chrome and reopen
( cd packages/bridge && bun run dev:cli doctor )             # 4 green ✓ = ready
claude mcp add byob -s user -- /Users/$USER/code/byob/packages/mcp-server/node_modules/.bin/tsx /Users/$USER/code/byob/packages/mcp-server/bin/byob-mcp.ts
```

Then in any Claude Code session: *"use byob to ..."*.

---

## 10 tools

| Tool | Purpose |
|---|---|
| 📖 `browser_read` | Auto-scroll a page, return text + structured chunks with screen positions |
| 📸 `browser_screenshot` | Save PNG/JPEG to disk, return path (not base64 — saves LLM tokens) |
| 🖱️ `browser_click` | Real CDP mouse events (passes anti-bot, not synthetic DOM events) |
| ⌨️ `browser_type` | Focus + type, optional clear / pressEnter |
| 🍪 `browser_get_cookies` | Dump cookies for a domain — replay in `curl` later |
| 🚀 `browser_navigate` | Open or reuse a tab; supports `load`/`domcontentloaded`/`networkidle` |
| ⏳ `browser_wait_for` | MutationObserver wait for visible/hidden/attached/detached |
| 🗂️ `browser_list_tabs` | All open tabs with id/url/title/active |
| 🎯 `browser_switch_tab` | Activate a tab + bring its window to foreground |
| ⚡ `browser_eval` | Run JS in a tab — **opt-in via `BYOB_ALLOW_EVAL=1`** |

Schemas: [`shared/src/schemas.ts`](shared/src/schemas.ts).

---

## What's behind the magic

```
Claude Code  ─stdio→  byob-mcp  ─UNIX socket→  byob-bridge  ─Native Messaging→  byob extension  ─CDP→  Chrome
```

3 Node processes + 1 Chrome extension. **All on your laptop.** Zero network calls. When Chrome closes, all processes auto-die. RAM use at idle: `0`.

---

## Security highlights

- 🔒 **`browser_eval` hidden by default** — set `BYOB_ALLOW_EVAL=1` to expose it; rate-limited 5/min/tab; every call audit-logged + Chrome notification
- 🚫 **URL blacklist** — `chrome:` / `file:` / auth domains denied by default
- 🔑 **Per-user RSA key** — every install gets its own extension ID, no global ID collisions
- 📁 **Sockets `0600`, dirs `0700`** — bridge enforces `umask(0o077)`
- 📡 **Zero outbound traffic** — byob doesn't phone home, no telemetry, no auto-update ping
- ⚠️ **Yellow "byob is debugging" Chrome banner** is by design — every CDP user lives with it

---

## Management CLI

```sh
byob install     # one-shot: key + build + manifests
byob doctor      # diagnose every link in the chain
byob bridges     # list live bridge processes
byob logs [-f]   # tail ~/.byob/bridge.log
byob uninstall   # remove launcher + manifests
```

---

## More

- [Design spec](docs/superpowers/specs/2026-04-25-byob-design.md) — every protocol, every flow, every rejected alternative
- [CHANGELOG](CHANGELOG.md) — full v0.1 feature log + v0.2 deferred list
- [CONTRIBUTING](CONTRIBUTING.md) — local setup + house rules + welcome PR areas
- [E2E checklist](docs/e2e-checklist.md) — manual tests run before each release

<details>
<summary>Troubleshooting</summary>

| Symptom | Fix |
|---|---|
| `No live bridge` | Chrome closed or extension disabled — check `chrome://extensions` |
| `cdp_attach_failed` | Close DevTools (F12); byob also retries 3× internally |
| `url_forbidden` on a real URL | URL is on default blacklist — see Security |
| `extension_not_connected` | Reload extension at `chrome://extensions` |
| New install not picked up | Fully ⌘Q Chrome and reopen — Native Messaging manifests are read at launch only |

</details>

---

MIT License. byob borrows enormous power from your Chrome — use it on machines and accounts you control.
