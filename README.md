<div align="center">

<img src="assets/logo.svg" alt="byob" width="120"/>

# byob

**Bring Your Own Browser** — let your AI assistant use the Chrome you already have open.

[![License: MIT](https://img.shields.io/badge/license-MIT-22c55e.svg)](LICENSE) [![MCP](https://img.shields.io/badge/MCP-stdio-0a0a0a.svg)](https://modelcontextprotocol.io) [![Chrome MV3](https://img.shields.io/badge/Chrome-MV3-f59e0b.svg)](https://developer.chrome.com/docs/extensions/mv3/intro/) [![v0.5](https://img.shields.io/badge/v0.5-ready-22c55e.svg)](CHANGELOG.md)

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
"fill in this form with my details and submit it"
```

|  | WebFetch | Headless Puppeteer | **byob** |
|---|:-:|:-:|:-:|
| Sees logged-in pages | ❌ | ⚠️ manual cookie copy | ✅ already logged in |
| Passes bot detection | ❌ | ❌ | ✅ real human browser |
| Setup time | 0 | hours | **~5 min** |
| Cloud cost | free | $$ | free |

Compared with tools that attach over Chrome's remote-debugging port (DevTools MCP, agent-browser, Playwright `--cdp`): byob is an extension, so there's **no debugging port to open, no "Allow remote debugging?" prompt on every connection**, and nothing else on your machine can hijack your logged-in browser through it.

---

## Install

### Quick install (recommended)

```sh
curl -fsSL https://raw.githubusercontent.com/wxtsky/byob/main/install.sh | bash
```

On Windows, run the same command from Git Bash or MSYS2. The script checks prerequisites (Node.js ≥ 20, bun, Chrome/Edge/Brave), clones the repo, builds everything, and walks you through MCP registration interactively. If bun is not installed, it offers to install it for you using the native installer for your OS.

> Set `BYOB_INSTALL_DIR` to change the install location (default: `~/byob`). Advanced: `BYOB_REPO`, `BYOB_REF`, and `BYOB_SKIP_SETUP=1` are supported for forks, pinned refs, and CI-style dependency install only.

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
5. Prompts you to multi-select your AI tools. Claude Code gets the bundled
   plugin (Skill + auto-started MCP); other clients get their MCP config.

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

### Step 4 — Claude Code plugin / manual MCP reference

The setup script registers your selected tools automatically. The block below is for reference only — use it if you skipped the prompt or want to register a different tool later:

<details open>
<summary><b>Claude Code plugin (recommended)</b></summary>

```sh
claude plugin marketplace add wxtsky/byob
claude plugin install byob@byob --scope user
```

Run `/reload-plugins` in Claude Code after installing. The plugin includes the
`/byob:control-chrome` Skill and starts its bundled MCP server automatically;
do not also register a second `byob` MCP server.

For local development without installing:

```sh
claude --plugin-dir /path/to/byob/plugins/byob
```

</details>

<details>
<summary><b>Claude Code manual MCP fallback</b></summary>

```sh
claude mcp add byob -s user -- /path/to/tsx /path/to/byob-mcp.ts
```

To enable `browser_evaluate`, add `-e BYOB_ALLOW_EVAL=1` after `-s user`.

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
> To enable `browser_evaluate`, add `"env": { "BYOB_ALLOW_EVAL": "1" }` to the config (or `-e BYOB_ALLOW_EVAL=1` for CLI tools).

### Step 5 — Wait for setup to confirm the bridge is online

After you finish steps 2 and 3 (load the extension and ⌘Q-restart Chrome), **setup auto-detects the bridge coming online** and prints `✓ bridge online`. The installation is complete — open a new session in your AI tool and try _"use byob to read ..."_.

If you exited setup early with Ctrl+C, or want to check the state later:

```sh
bun run doctor
```

`bun run doctor` prints actionable fixes under every `✗` (e.g. "⌘Q-restart Chrome", "extension ID mismatch", etc.).

---

## Tools

v0.5 has 25 tools. Elements are targeted by **refs** from the snapshot (`[ref=e12]`), a CSS selector, or x/y.

| Tool | What it does |
|---|---|
| `browser_snapshot` | The page as an accessibility outline with refs — interactive-only, diff, scoped; iframes (even cross-origin) inline |
| `browser_find` | Find by role+name / text / label / placeholder / testId, optionally click/fill/check right away |
| `browser_click` | Click (real mouse events), double/right click, modifiers; auto-waits and reports navigation / new tabs / dialogs |
| `browser_type` | Fill inputs, textareas, contenteditable (React/Vue-safe); per-key mode; submit |
| `browser_press_key` | Keys and combos with real key codes (`Enter`, `Shift+Tab`, `ControlOrMeta+A`) |
| `browser_hover` / `browser_select` / `browser_scroll` / `browser_drag` | Menus, `<select>`, page or container scrolling, HTML5 drag-and-drop |
| `browser_upload_file` | Attach local files to `<input type=file>` |
| `browser_batch` | Many steps in one call (fill a whole form and submit) |
| `browser_wait` | Wait for element state, text, URL, load / network idle |
| `browser_read` | Content as text / markdown (reader mode) / html / links / tables, with outline and filter |
| `browser_screenshot` | Viewport / full page / element / clip → image returned to the model; ref labels; PDF |
| `browser_navigate` | Open a URL in a background tab, back / forward / reload |
| `browser_tabs` | List / open / select / close tabs, search history |
| `browser_console` | Console messages and page errors, buffered |
| `browser_network` | Record traffic (summary / JSON / HAR) or intercept: block / mock / modify |
| `browser_inspect` | Element box / state / styles, Web Vitals |
| `browser_storage` | Cookies and local/session storage — get / set / clear |
| `browser_dialog` | Answer alert / confirm / prompt explicitly |
| `browser_emulate` | Device, dark mode, geolocation, timezone, locale, offline, headers |
| `browser_clipboard` | Read / write clipboard text |
| `browser_download_images` | Save a page's images |
| `browser_evaluate` | Run page JavaScript (only with `BYOB_ALLOW_EVAL=1`) |

Schemas: [`shared/src/tools.ts`](shared/src/tools.ts). Upgrading from 0.4? Tool names changed — see the [changelog](CHANGELOG.md#050).

---

## How it works

```
AI tool → byob-mcp → byob-bridge → Chrome extension → your tab
         (stdio)    (Unix socket) (Native Messaging) (Chrome DevTools Protocol)
```

- byob's own page scripts run in an **isolated world**: they share the DOM but not JavaScript with the page — no `window.__byob*`, no `data-byob-*` attributes, nothing a site can see or tamper with.
- Refs live in the extension's memory, bound to Chrome's backend node ids; they survive re-renders and are refused (never silently re-targeted) after navigation.
- Each MCP client session has its own working tab; tabs the agent opens are grouped under **byob** and never steal focus.

All communication stays local. No data leaves your machine. When Chrome closes, all byob processes exit automatically.

---

## Everyday commands

```sh
bun run setup      # install or re-install
bun run doctor     # check what's working
bun run bridges    # list running bridge processes
bun run logs       # tail the bridge log
bun run unsetup    # remove everything
bun run policy     # show / change which sites byob may touch (flags below)
```

All run from the byob repo root.

---

## Reliability

- **Auto-waiting actions.** Before clicking or typing, byob waits until the element is attached, visible, stable, enabled and actually on top at its center; errors say what's wrong ("covered by `<div#cookie-banner>`").
- **Actions report their effects** — navigation (waited for), same-page URL changes, new tabs, JS dialogs — so the agent doesn't have to poll.
- **Dialogs never hang a call.** A click that opens `confirm()` returns immediately with the dialog text.
- **End-to-end cancellation.** `Ctrl+C` propagates through the entire chain (MCP → bridge → extension → Chrome).
- **Sleep/wake recovery.** After a laptop sleep cycle, byob resets its debug sessions so the next call starts clean.
- **Tested end to end** on Chrome for Testing: `BYOB_E2E=1 bun test e2e` (see [CONTRIBUTING](CONTRIBUTING.md)).

---

## Security

- `browser_evaluate` (and `browser_wait`'s `fn`) are **off by default** — enable with `BYOB_ALLOW_EVAL=1`. Every call is audit-logged.
- `chrome://`, `file://`, Google/MS/Apple login pages are blocked by default.
- **Per-site allow/deny lists**, set by you — never by the agent:

  ```sh
  bun run policy --deny "**.chase.com" "mail.proton.me"   # never touch these
  bun run policy --allow "**.github.com"                  # or: only these
  bun run policy --clear-allow --clear-deny                # reset
  bun run policy --allow-file on                           # permit file:// URLs
  ```

  Patterns: `example.com` (exact), `*.example.com` (subdomains only), `**.example.com` (apex + subdomains), `*` (everything). Deny wins over allow. A non-empty allow list means allow-list-only. Enforced when byob attaches to a tab, so it covers **every** tool.
- **JS dialogs are never auto-accepted**; a confirm stays open until the agent answers it explicitly.
- **Credential fields are redacted.** Values in password / OTP / card / email inputs are never sent to the model; they surface as `[redacted]`.
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
| `url_forbidden` | Blocked by your site policy | `bun run policy` |
| `stale_ref` | The page navigated since the snapshot | Snapshot again |
| `element_covered` | A banner / modal is on top | Close it, or `force:true` |
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
- [Manual release checklist](docs/e2e-checklist.md)

MIT licensed. byob has broad access to your browser — only use it on machines and accounts you own.
