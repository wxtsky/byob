<div align="center">

<img src="assets/logo.svg" alt="byob" width="120"/>

# byob

**Bring Your Own Browser** — let your AI assistant use the Chrome you already have open.

[![License: MIT](https://img.shields.io/badge/license-MIT-22c55e.svg)](LICENSE) [![MCP](https://img.shields.io/badge/MCP-stdio-0a0a0a.svg)](https://modelcontextprotocol.io) [![Chrome MV3](https://img.shields.io/badge/Chrome-MV3-f59e0b.svg)](https://developer.chrome.com/docs/extensions/mv3/intro/) [![v0.3](https://img.shields.io/badge/v0.3-ready-22c55e.svg)](CHANGELOG.md)

**English** · [中文](README.zh-CN.md)

</div>

---

byob is a local MCP server that lets AI coding tools (Claude Code, Cursor, Cline, Windsurf, etc.) directly control **your real Chrome** — the one where you're already logged into everything.

```
"read my Twitter timeline and summarize the top 5 posts"
"google 'mcp protocol spec', click the first result, read the page"
"take a screenshot of example.com"
"grab my GitHub session cookie so I can curl with it"
"open my Gmail tab and tell me how many unread"
```

|  | WebFetch | Headless Puppeteer | **byob** |
|---|:-:|:-:|:-:|
| Sees logged-in pages | ❌ | ⚠️ manual cookie copy | ✅ already logged in |
| Passes bot detection | ❌ | ❌ | ✅ real human browser |
| Setup time | 0 | hours | **~5 min** |
| Cloud cost | free | $$ | free |

---

## Install

### Quick install (recommended)

```sh
curl -fsSL https://raw.githubusercontent.com/wxtsky/byob/main/install.sh | bash
```

The script checks prerequisites (Node.js ≥ 20, bun, Chrome), clones the repo, builds everything, and walks you through MCP registration interactively. If bun is not installed, it offers to install it for you.

> Set `BYOB_INSTALL_DIR` to change the install location (default: `~/byob`).

### Manual install

<details>
<summary>Prefer to do it yourself?</summary>

Requires **Node.js ≥ 20**, **bun**, **Chrome**, and any MCP-compatible AI tool.

```sh
git clone https://github.com/wxtsky/byob
cd byob
bun install
bun run setup
```

</details>

`bun run setup` walks through the install interactively:

1. Pick output language (English / 中文)
2. Generates a unique extension key for you
3. Builds the Chrome extension
4. Writes the config that lets Chrome talk to byob
5. Prompts you to multi-select your AI tools, then registers each one (CLI tools via their `mcp add` command, JSON-config tools by writing the config file directly)

After the script finishes, three manual steps remain:

### Step 2 — Load extension in Chrome

Open `chrome://extensions` in Chrome.

1. Top-right → turn ON **Developer mode**
2. Top-left → click **Load unpacked**
3. Select the folder printed in your terminal, something like:
   ```
   /your/path/to/byob/packages/extension/output/chrome-mv3
   ```

### Step 3 — Restart Chrome

**Quit Chrome completely** (`⌘Q` on Mac / close all windows on Windows), then reopen.

> Closing a single tab or window is not sufficient — Chrome only reads the Native Messaging config at startup.

### Step 4 — (Reference) Manual MCP registration

The setup script registers your selected tools automatically. The block below is for reference only — use it if you skipped the prompt or want to register a different tool later:

<details open>
<summary><b>Claude Code</b></summary>

```sh
claude mcp add byob -s user -- /path/to/tsx /path/to/byob-mcp.ts
```

To enable `browser_eval`, add `-e BYOB_ALLOW_EVAL=1` after `-s user`.

</details>

<details>
<summary><b>Codex CLI</b></summary>

```sh
codex mcp add byob -- /path/to/tsx /path/to/byob-mcp.ts
```

</details>

<details>
<summary><b>Cursor</b></summary>

Add to `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):

```json
{
  "mcpServers": {
    "byob": {
      "command": "/path/to/tsx",
      "args": ["/path/to/byob-mcp.ts"]
    }
  }
}
```

</details>

<details>
<summary><b>Windsurf</b></summary>

Add to `~/.codeium/windsurf/mcp_config.json` (same JSON format as Cursor):

```json
{
  "mcpServers": {
    "byob": {
      "command": "/path/to/tsx",
      "args": ["/path/to/byob-mcp.ts"]
    }
  }
}
```

</details>

<details>
<summary><b>Cline (VS Code)</b></summary>

Open Cline sidebar → MCP Servers → Configure, then add (same JSON format):

```json
{
  "mcpServers": {
    "byob": {
      "command": "/path/to/tsx",
      "args": ["/path/to/byob-mcp.ts"]
    }
  }
}
```

</details>

> The actual paths are printed by the setup script. The examples above use shortened paths for readability.  
> To enable `browser_eval`, add `"env": { "BYOB_ALLOW_EVAL": "1" }` to the config (or `-e BYOB_ALLOW_EVAL=1` for CLI tools).

### Step 5 — Verify

```sh
bun run doctor
```

If all checks pass (4 green ✓), the installation is complete. Open a new session in your AI tool and try _"use byob to read ..."_.

---

## Tools

| Tool | What it does |
|---|---|
| `browser_read` | Open a page, scroll through, read all text |
| `browser_read_markdown` | Same, returns clean markdown (no nav/ads) |
| `browser_extract_table` | Pull `<table>` elements as JSON |
| `browser_get_console_logs` | Snapshot console.log / warn / error |
| `browser_start_record_network` | Start recording HTTP + WebSocket traffic |
| `browser_stop_record_network` | Stop recording, export JSON or HAR |
| `browser_screenshot` | Screenshot → saved to disk |
| `browser_download_images` | Download all images from a page |
| `browser_click` | Click a button or link |
| `browser_type` | Type into an input (optionally press Enter) |
| `browser_press_key` | Send a keyboard key (Enter, Escape, F5, ArrowDown, ...) |
| `browser_hover` | Hover the mouse over an element to trigger tooltips/menus |
| `browser_select` | Choose an option in a native `<select>` |
| `browser_scroll` | Scroll to top/bottom, an element, or a Y coordinate |
| `browser_get_html` | Get raw HTML of an element or the whole page |
| `browser_get_cookies` | Export cookies for `curl` / scripts |
| `browser_navigate` | Open a URL in a new or existing tab |
| `browser_go_back` | Go back one step in browser history |
| `browser_go_forward` | Go forward one step in browser history |
| `browser_wait_for` | Wait for an element to appear |
| `browser_list_tabs` | List all open tabs |
| `browser_switch_tab` | Switch to a tab |
| `browser_close_tab` | Close a tab by tabId |
| `browser_eval` | Run JavaScript on the page (off by default) |
| `browser_set_cookies` | Write a cookie via `chrome.cookies.set` (CHIPS-aware). |
| `browser_print_pdf` | Save current page as PDF (default `~/.byob/pdfs/`). |
| `browser_get_storage` | Read `localStorage` / `sessionStorage` for an origin. |
| `browser_get_performance` | Page Web Vitals + navigation timing. |
| `browser_upload_file` | Upload local files to `<input type="file">`. |

16 of these tools support `framePath` to reach into nested iframes (including cross-origin).

Full schemas: [`shared/src/schemas.ts`](shared/src/schemas.ts)

---

## How it works

```
AI tool → byob-mcp → byob-bridge → Chrome extension → your tab
         (stdio)    (Unix socket) (Native Messaging) (Chrome DevTools Protocol)
```

All communication stays local. No data leaves your machine. When Chrome closes, all byob processes exit automatically.

---

## Everyday commands

```sh
bun run setup      # install or re-install
bun run doctor     # check what's working
bun run bridges    # list running bridge processes
bun run logs       # tail the bridge log
bun run unsetup    # remove everything
```

All run from the byob repo root.

---

## Reliability

- **End-to-end cancellation.** `Ctrl+C` propagates through the entire chain (MCP → bridge → extension → Chrome), cleanly detaching all debug sessions.
- **DevTools conflict handling.** If DevTools is open on a tab, `browser_eval` automatically falls back to `chrome.scripting.executeScript`.
- **Sleep/wake recovery.** After a laptop sleep cycle, byob resets all debug sessions so the next call starts from a clean state.

---

## Security

- `browser_eval` is **off by default** — enable with `BYOB_ALLOW_EVAL=1`. Every call logs + notifies.
- `chrome://`, `file://`, Google/MS/Apple login pages are blocked by default.
- Each install gets a unique extension key — no collisions.
- Socket files are `0600`, dirs are `0700`. Other users can't see them.
- **Zero outbound network traffic.** No analytics, no pings, no crash reports.
- Chrome displays a "byob is debugging this browser" banner on active tabs. This is a Chrome security feature and cannot be suppressed.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `No live bridge` | Chrome not running or extension disabled | Check `chrome://extensions` |
| `cdp_attach_failed` | DevTools open on that tab | Close DevTools |
| `url_forbidden` | URL on the blocklist | See Security section |
| `extension_not_connected` | Extension lost connection | Reload at `chrome://extensions` |
| Nothing works after install | Chrome was not fully restarted | Quit Chrome completely (`⌘Q`) and reopen |

Run `bun run doctor` for detailed diagnostics on which step failed.

---

## Platform notes

| Platform | Auto | Manual |
|---|---|---|
| **macOS** | Auto-registers selected MCP tools | Open `chrome://extensions` and load the unpacked extension |
| **Windows** | Same + writes Native Messaging host to registry | Same as macOS |
| **Linux** | Auto-registers selected MCP tools | Same as macOS |

---

## More

- [Changelog](CHANGELOG.md)
- [Contributing](CONTRIBUTING.md)
- [Design notes](docs/superpowers/specs/2026-04-25-byob-design.md)
- [Test checklist](docs/e2e-checklist.md)

MIT licensed. byob has broad access to your browser — only use it on machines and accounts you own.
