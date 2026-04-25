# byob — Bring Your Own Browser

Local-only browser bridge for AI agents (MCP). Lets Claude Code / Cursor / Cline drive your real Chrome — with your cookies, your sessions, your reCAPTCHA solves.

```
┌─────────────────┐  MCP stdio   ┌─────────────┐  HTTP over   ┌─────────────┐  Native      ┌─────────────────┐  CDP    ┌────────────────┐
│ Claude Code /   │ ──────────▶ │ byob-mcp    │  UNIX socket │ byob-bridge │  Messaging   │ byob-extension  │ ──────▶ │ Chrome tab     │
│ Cursor / Cline  │             │ (Node)      │ ───────────▶ │ (Node)      │ ──────────▶ │ (MV3 SW, WXT)   │         │ (real session) │
└─────────────────┘             └─────────────┘              └─────────────┘              └─────────────────┘         └────────────────┘
```

## Quick Start (5 min)

```sh
# 1. clone + install
git clone <this-repo> ~/code/byob
cd ~/code/byob
bun install

# 2. generate an extension key (one time, kept out of repo)
mkdir -p ~/.byob
openssl genrsa -out ~/.byob/extension-key.pem 2048
openssl rsa -in ~/.byob/extension-key.pem -pubout -outform DER | base64 | tr -d '\n'
# copy the output, paste into packages/extension/wxt.config.ts → manifest.key

# 3. build extension + install bridge (use cd, not bun --cwd — see note below)
( cd packages/extension && bun run build )
( cd packages/bridge    && bun run dev:cli install --dev )

# 4. load the extension in Chrome
# chrome://extensions → Developer mode → "Load unpacked"
# → select packages/extension/.output/chrome-mv3
# → ⌘Q Chrome and reopen (so it reads the new NM manifest)

# 5. verify
( cd packages/bridge && bun run dev:cli doctor )
# ✓ ✓ ✓ ✓ all green = ready

# 6. register MCP with Claude Code (single line, do NOT line-break inside the args!)
claude mcp add byob -s user -- /Users/$USER/code/byob/packages/mcp-server/node_modules/.bin/tsx /Users/$USER/code/byob/packages/mcp-server/bin/byob-mcp.ts
# (add `-e BYOB_ALLOW_EVAL=1` after `-s user` to enable browser_eval — see Security)
```

> **bun quirk note:** `bun --cwd <abspath> run <script>` swallows the `<script>`
> arg in some bun versions. Use `cd ... && bun run ...` or invoke `tsx` directly
> (as the MCP registration above does).

## Tools

| Tool | What it does |
|---|---|
| `browser_read` | Read full page text (auto-scrolls, lazy-load aware), returns chunks with screen positions |
| `browser_screenshot` | Save screenshot to disk; returns path |
| `browser_click` | Click an element by selector (real mouse events via CDP) |
| `browser_type` | Type into an input (optional clear / Enter) |
| `browser_get_cookies` | Export cookies for a domain (great for `curl` follow-ups) |
| `browser_navigate` | Open or update a tab to a URL |
| `browser_wait_for` | Wait for a selector to be visible / hidden / attached |
| `browser_list_tabs` | List all open tabs |
| `browser_switch_tab` | Activate a tab by id |
| `browser_eval` | Run JS in a tab (DANGER, opt-in via `BYOB_ALLOW_EVAL=1`) |

## Security

- **Bridge socket** mode `0600` (only your user).
- **`browser_eval`** is hidden from MCP unless `BYOB_ALLOW_EVAL=1` is set on the MCP server's environment. Each call writes a line to `~/.byob/eval-audit.log` and triggers a Chrome notification. Throttled to 5 calls/min/tab.
- **URL blacklist** — `chrome:`, `chrome-extension:`, `about:`, `devtools:`, `view-source:`, `file:` protocols, and `accounts.google.com` / `login.microsoftonline.com` / `appleid.apple.com` hostnames. Override with `BYOB_ALLOW_FILE=1` / `BYOB_ALLOW_AUTH_DOMAINS=1` on the extension side (Open Question — Phase 5 ships server-side gates; mirror to extension is v0.2).
- **Chrome will show a yellow "byob is debugging this tab" banner** when CDP is attached. This is a Chrome safety guarantee — it cannot be hidden.

## Management CLI

```sh
byob install [--dev]      # write launcher + NM manifest
byob doctor               # connectivity diagnosis
byob bridges              # list live bridge processes
byob logs [-f]            # tail ~/.byob/bridge.log
byob uninstall            # remove launcher + manifests
```

## Troubleshooting

| Symptom | Try |
|---|---|
| `No live bridge` | `byob doctor` — most likely Chrome closed or extension disabled |
| `cdp_attach_failed` | Close DevTools (F12) on the target tab; pass explicit `tabId` if calling without one |
| `extension_not_connected` | Reload the extension in chrome://extensions |
| `bridge_not_running` after Chrome quit | Reopen Chrome; bridge is ephemeral and Chrome owns its lifetime |
| `url_forbidden` on a legit URL | The URL is on the default blacklist; see Security section |

## Architecture

See `docs/superpowers/specs/2026-04-25-byob-design.md`.

## Status (v0.1)

- ✅ 10 tools end-to-end via MCP
- ✅ Native Messaging round-trip with reconnect, multi-bridge support
- ✅ CDP collector / scroll loop / chunk extraction
- ⚠️ Cancel propagation (Ctrl+C → CDP detach) — partial, deferred to v0.2
- ⚠️ CDP fallback to `chrome.scripting` when DevTools occupies the target — deferred to v0.2
- ⚠️ Chrome Web Store packaging — not yet (use Load Unpacked)

Built by wxt + Claude (Opus 4.7).
