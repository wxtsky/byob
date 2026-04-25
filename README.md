<div align="center">

<img src="assets/logo.svg" alt="byob" width="120"/>

# byob

**Bring Your Own Browser** — let your AI assistant use the Chrome you already have open.

[![License: MIT](https://img.shields.io/badge/license-MIT-22c55e.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-stdio-0a0a0a.svg)](https://modelcontextprotocol.io)
[![Chrome MV3](https://img.shields.io/badge/Chrome-MV3-f59e0b.svg)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![v0.2](https://img.shields.io/badge/v0.2-ready-22c55e.svg)](CHANGELOG.md)

**English** · [中文](README.zh-CN.md)

</div>

---

## What can I do with this?

You ask Claude (or Cursor / Cline) to do something on the web. byob makes it happen in **your real Chrome** — the one where you're already logged into Twitter, GitHub, Gmail, your work tools, everything.

A few things people actually ask:

> *"read my Twitter timeline and tell me the top 5 posts"*

byob opens a tab, scrolls through it, hands the text back. **Because it's your real browser, your tweets show up — no fake account, no copy-pasting cookies, no captchas.**

> *"google 'mcp protocol spec', click the first result, and read the page"*

byob goes to google.com, types your search, hits Enter, waits for results, clicks the first link, reads it. **All in one prompt.**

> *"give me my github session cookie so I can use curl in a script"*

byob hands you the cookie. Now `curl https://github.com/...` works just like you're logged in.

> *"take a screenshot of example.com"*

byob saves a PNG to disk and tells Claude where it is. (Doesn't dump base64 into Claude's context — that would burn through your tokens.)

> *"open my Gmail tab and tell me how many unread"*

Cloud headless browsers can't see your Gmail because they're not logged in. byob can — **because it IS your browser**.

---

## Why not just `WebFetch` or Puppeteer?

|  | WebFetch | Headless Puppeteer | **byob** |
|---|:-:|:-:|:-:|
| Sees pages that need login | ❌ | ⚠️ have to copy cookies in | ✅ already logged in |
| Gets past "are you a bot?" checks | ❌ | ❌ | ✅ it really is a human's browser |
| Setup time | 0 | hours | **5 min** |
| Costs cloud money | nope | yes | nope |

---

## 5-minute install

```sh
git clone https://github.com/wxtsky/byob ~/code/byob
cd ~/code/byob && bun install

# one command does everything: makes a key, builds the extension,
# writes the Native Messaging manifest
( cd packages/bridge && bun run dev:cli install --dev )
```

On **macOS** that command auto-opens `chrome://extensions` for you and copies the
`claude mcp add byob …` line to your clipboard. Then:

1. In the Chrome window that just opened: turn on **Developer mode**, click **Load unpacked**, pick `packages/extension/.output/chrome-mv3`.
2. Fully **quit Chrome** (⌘Q) and reopen so it picks up the bridge manifest.
3. Paste the clipboard line into your terminal (registers byob with Claude Code). Add `-e BYOB_ALLOW_EVAL=1` after `-s user` if you want `browser_eval`.
4. `( cd packages/bridge && bun run dev:cli doctor )` → expect **4 green ✓**.

Open a fresh Claude Code session and say *"use byob to ..."*.

> Linux / Windows: skip step 1 (open `chrome://extensions` yourself). Steps 2–4 are the same.

---

## The 16 things byob can do

| Tool | What it does |
|---|---|
| 📖 `browser_read` | Open a page, scroll through it, read everything |
| 📝 `browser_read_markdown` | Same but returns clean markdown (no nav, no ads) |
| 📊 `browser_extract_table` | Pull `<table>`s off a page as JSON |
| 🪵 `browser_get_console_logs` | Snapshot the page's `console.log/warn/error` + JS exceptions |
| 🌐 `browser_start_record_network` / `browser_stop_record_network` | Record HTTP + WebSocket traffic, save as JSON or HAR |
| 📸 `browser_screenshot` | Take a screenshot, save to disk |
| 🖼️ `browser_download_images` | Grab every image on a page to disk |
| 🖱️ `browser_click` | Click a button or link |
| ⌨️ `browser_type` | Type into a text box (and hit Enter if you want) |
| 🍪 `browser_get_cookies` | Grab the cookies for a site so you can `curl` it later |
| 🚀 `browser_navigate` | Go to a URL in a new or existing tab |
| ⏳ `browser_wait_for` | Wait until something appears on the page |
| 🗂️ `browser_list_tabs` | Show me all my open tabs |
| 🎯 `browser_switch_tab` | Switch to a specific tab |
| ⚡ `browser_eval` | Run any JavaScript on the page (off by default — see Security) |

**Works inside iframes too.** 9 of these tools accept a `framePath: ["#outer iframe", "#inner iframe"]`
hop list — including cross-origin (OOPIF) iframes. Useful for sites that
hide everything inside a sandbox iframe (Notion, Stripe Checkout, etc.).

Full input/output shapes: [`shared/src/schemas.ts`](shared/src/schemas.ts).

---

## How it actually works

```
Claude Code  ─→  byob-mcp  ─→  byob-bridge  ─→  Chrome extension  ─→  your Chrome tab
```

Four hops, all on your laptop. Nothing leaves your machine. Close Chrome and everything quits — no background processes hanging around.

---

## Stuff to know about reliability

- **Hit `Ctrl+C` and it actually stops.** v0.2 wires the cancel signal all the way through — mcp-client → bridge → extension → CDP detach. No more stuck "browser is debugging" banner because the agent gave up but Chrome didn't get the memo.
- **DevTools open on a tab? `browser_eval` still works.** It falls back to `chrome.scripting.executeScript` (page world). The result has `_meta.fallbackUsed: true` so you can tell.
- **Closed your laptop and reopened?** byob notices the wake (alarms + idle dual detector), aborts any in-flight recordings, and detaches every CDP session so the next call starts clean.

---

## Stuff to know about safety

- 🔒 **`browser_eval` (run JS) is off by default** — even Claude doesn't see it exists. Turn it on by setting `BYOB_ALLOW_EVAL=1` when you register the MCP. When it's on, every call gets logged and pops a Chrome notification.
- 🚫 **Some sites are blocked by default** — `chrome://`, `file://`, your Google/Microsoft/Apple login pages. So Claude can't accidentally read your password manager or `/etc/passwd`.
- 🔑 **You get your own extension key** — when you install, byob makes a key just for you. Two people running byob get two different extension IDs, no clash.
- 📁 **Files are private** — sockets are `0600`, folders are `0700`. Other users on your computer can't read them.
- 📡 **byob never phones home** — no analytics, no auto-update pings, no crash reports. Zero outbound traffic.
- ⚠️ **Chrome will show "byob is debugging this tab"** at the top of the page. **There is no way to hide it** — that's a Chrome safety thing, not a byob bug. Every tool that uses Chrome's debugger has the same banner.

---

## Day-to-day commands

```sh
byob install     # set everything up (or fix it after Chrome breaks)
byob doctor      # check what's working and what's not
byob bridges     # show me the running bridges
byob logs [-f]   # tail the log
byob uninstall   # nuke the launcher and manifests
```

---

## Want to know more?

- [Design notes](docs/superpowers/specs/2026-04-25-byob-design.md) — how byob works under the hood and why
- [Changelog](CHANGELOG.md) — what's done and what's coming
- [Contributing](CONTRIBUTING.md) — how to send a PR
- [Test checklist](docs/e2e-checklist.md) — things to try before each release

<details>
<summary>Something's broken — what do I do?</summary>

| What you see | What's probably wrong |
|---|---|
| `No live bridge` | Chrome isn't open, or the byob extension is disabled. Check `chrome://extensions`. |
| `cdp_attach_failed` | DevTools (F12) is open on that tab. Close it. |
| `url_forbidden` on a normal URL | The URL is on the default blocklist (see Safety). Use a different tab. |
| `extension_not_connected` | Reload the byob extension at `chrome://extensions`. |
| Just installed but nothing works | Fully quit Chrome (⌘Q) and reopen. Chrome only checks for the byob bridge when it starts up. |

Still stuck? Run `byob doctor` — it tells you exactly which step is broken.

</details>

---

MIT licensed. byob has a lot of access to your browser — only run it on machines and accounts you own.
