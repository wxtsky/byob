# Contributing to byob

**English** · [中文](CONTRIBUTING.zh-CN.md)

---

Thanks for considering a contribution. byob is a tight project — a few hundred lines per package — so it's easy to read end-to-end before touching anything.

---

## Project layout

```
byob/
├── shared/                # @byob/shared — Zod schemas + command names
├── packages/
│   ├── extension/         # @byob/extension — MV3, built with WXT
│   ├── bridge/            # @byob/bridge — Native Messaging host + management CLI
│   └── mcp-server/        # @byob/mcp-server — stdio MCP server
├── assets/                # logo SVGs (rendered to PNG via scripts/build-icons.ts)
├── scripts/               # build helpers
└── docs/superpowers/      # design spec + implementation plan
```

`shared/` is the single source of truth — every cross-process schema lives there. Touch it when changing protocol, then propagate.

---

## Local setup (5 minutes)

```sh
git clone https://github.com/<you>/byob ~/code/byob
cd ~/code/byob
bun install

( cd packages/bridge && bun run dev:cli install --dev )
# Follow the printed next-steps to load the extension in chrome://extensions.
( cd packages/bridge && bun run dev:cli doctor )
# All four ✓ = ready to hack.
```

`byob install --dev` makes the bridge run from source via `tsx`, so changes to `packages/bridge/src/**` are picked up next time the extension reconnects.

For extension changes, rebuild + reload the unpacked extension:

```sh
( cd packages/extension && bun run build )   # then chrome://extensions → reload
```

---

## House conventions

- **Bash prefix**: `unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY;` — harmless if your shell has no proxy, mandatory if it does (matches the maintainer's setup).
- **bun quirk**: `bun --cwd <abspath> run <script>` swallows the `<script>` arg in current bun (1.3.x). Use `cd ... && bun run ...` or invoke `tsx` directly.
- **No `console.log` in `mcp-server`**. stdout is the MCP protocol channel; anything written there corrupts the wire. Use `console.error` for any diagnostic.
- **Handlers must NOT return top-level `type` or `requestId` keys.** The dispatcher writes the NM-protocol envelope (`type:'result'`, `requestId`) over whatever the handler returned, so handler payloads can never shadow these. (Caught by `EvalOutput` once — see commit `c0bde5d`'s history reference for the lesson.)
- **TypeScript strict** with `noUncheckedIndexedAccess` and `verbatimModuleSyntax`. We don't relax these.
- **Commits**: conventional-ish prefix (`feat(extension):`, `fix(bridge):`, `docs:`, `chore:`). One-line summary + a paragraph explaining *why*, not just *what*. `Co-Authored-By:` lines welcome.
- **All commits stay in working tree green.** `bun run typecheck` must pass on every commit, no exceptions.

---

## What kinds of PRs are welcome

The biggest open landing strips are in [CHANGELOG.md](CHANGELOG.md) "deferred to v0.2". In particular:

- **`browser_download_images` tool** — scroll trigger + per-image loopback HTTP upload. The bridge-side machinery already exists for screenshots; this just generalises.
- **Cancel propagation** — wire `req.on('close')` in `bridge/src/ipc-server.ts` to a `cancel` Native Messaging frame, dispatch `AbortController.abort()` on the extension side, propagate to in-flight CDP commands.
- **CDP → chrome.scripting fallback** in `browser_read` when attach fails (e.g. DevTools is open).
- **Wake/sleep detection** — bridge `setInterval(..., 1000)`, gap > 5s ⇒ send `{type:'wake'}` to extension; extension resets stale CDP sessions.
- **`browser_select_option`** for `<select>` elements (currently `browser_click` doesn't drive native selects properly).
- **Per-frame addressing** — extending the schema to carry a frameId, then resolving via `Page.getFrameTree` + executionContextId.

---

## Hard scope guardrails

byob has explicit non-goals captured in the design spec. PRs that add these will be respectfully closed:

- **SaaS / cloud component.** byob makes zero outbound network calls of its own; that stays.
- **In-page UI** (floating bubbles, sidebars, content-script-injected buttons). Users have an MCP client UI already.
- **Sandboxed LLM-code execution** (the `sandbox.html` pattern). `browser_eval` covers this with explicit opt-in.
- **Telemetry of any kind.** No usage metrics, no install pings, no crash uploads.

If you have an idea that touches these, open an issue first and let's discuss the use case.

---

## Releasing

`v0.1.0` was tagged after the e2e-checklist was passed end-to-end. Future releases:

1. Bump versions in `shared/package.json`, `packages/*/package.json`, `CHANGELOG.md`.
2. Run [`docs/e2e-checklist.md`](docs/e2e-checklist.md) by hand.
3. `git tag vX.Y.Z` and push.
4. (Eventually) `npm publish` the bridge + mcp-server packages.

---

## Testing philosophy

byob ships with no unit tests for cross-process logic on purpose — most bugs live at the protocol seams (CDP, Native Messaging, MCP) where mocks lie. Pure functions (`shared/src/*.ts`, `bridge/src/native-messaging.ts`, `bridge/src/extension-id.ts`) get small focused `bun test` coverage; everything else is covered by the manual e2e checklist.

If you find a regression that the e2e checklist misses, please add the case to `docs/e2e-checklist.md` as part of the fix PR.

---

## Code of conduct

Be kind. The maintainer is one person and reviewing PRs in their spare time. A "what" + a "why" in your PR description gets you to merge faster than a fait accompli with no context.
