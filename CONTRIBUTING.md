# Contributing to byob

Thanks for considering a contribution.

## Quick orientation

byob is a 4-package bun-workspaces TS monorepo:

| Package | Role |
|---|---|
| `shared/` | Zod schemas + command names — single source of truth |
| `packages/extension/` | MV3 extension (WXT) — runs in Chrome |
| `packages/bridge/` | Node Native Messaging host + management CLI |
| `packages/mcp-server/` | stdio MCP server consumed by Claude Code / Cursor / Cline |

## Local setup (5 minutes)

```sh
git clone <repo> ~/code/byob
cd ~/code/byob
bun install
( cd packages/bridge && bun run dev:cli install --dev )
# follow the on-screen prompts to load the unpacked extension
```

`byob install --dev` will auto-generate your local extension key, auto-build
the extension, and write Native Messaging manifests for every supported
browser it detects.

## Conventions

- **Bash**: prefix commands with `unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY;` (matches the maintainer's local environment, harmless elsewhere).
- **Bun quirk**: `bun --cwd <abspath> run <script>` does not pass the script arg through. Use `cd ... && bun run ...` or invoke `tsx` directly.
- **No `console.log` in mcp-server**. stdout is the MCP protocol channel — use `console.error` for everything.
- **Commit style**: conventional-ish (`feat(extension): ...`, `fix(bridge): ...`, `docs: ...`). Always include a one-line summary + a short paragraph explaining *why*. Trailing `Co-Authored-By:` lines welcome.
- **TypeScript strict** with `noUncheckedIndexedAccess`. We do not relax this.

## Workflow

1. Pick an issue or open one describing the bug/feature.
2. Create a branch.
3. Make the change. `bun run typecheck` must stay green across all 4 packages.
4. Reload extension (`chrome://extensions` → reload) + retest with `byob doctor`.
5. Open a PR.

## Areas accepting contributions

See `CHANGELOG.md` "deferred to v0.2" — those are wide-open. Especially:

- `browser_download_images` separate tool with loopback HTTP upload
- Cancel propagation end-to-end (mcp-client → bridge → CDP detach)
- CDP fallback to `chrome.scripting` when DevTools blocks attach
- Wake/sleep detection
- Cross-frame iframe support

## Safety / scope

byob's "non-goals" (see `docs/superpowers/specs/2026-04-25-byob-design.md`)
are deliberate. PRs that re-introduce SaaS, in-page UI bubbles, or sandboxed
LLM-code execution will be respectfully declined.
