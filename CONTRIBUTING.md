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
└── docs/                  # design specs + implementation plans
```

`shared/` is the single source of truth — every cross-process schema lives there. Touch it when changing protocol, then propagate.

---

## Local setup

See the main [README](README.md) for prerequisites (Node.js >= 20, bun, Chrome).

```sh
git clone https://github.com/wxtsky/byob
cd byob
bun install
bun run setup       # generates key, builds extension, writes config
# Follow the printed next-steps to load the extension in Chrome.
bun run doctor      # all four ✓ = ready to hack
```

`--dev` makes the bridge run from source via `tsx`, so changes to `packages/bridge/src/**` are picked up next time the extension reconnects — no build step needed.

For extension changes, rebuild then reload the unpacked extension:

```sh
( cd packages/extension && bun run build )   # then chrome://extensions → reload
```

---

## House conventions

- **Bash prefix**: `unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY;` — harmless if your shell has no proxy, mandatory if it does (matches the maintainer's setup).
- **bun quirk**: `bun --cwd <abspath> run <script>` swallows the `<script>` arg in current bun (1.3.x). Use `cd ... && bun run ...` or invoke `tsx` directly.
- **No `console.log` in `mcp-server`**. stdout is the MCP protocol channel; anything written there corrupts the wire. Use `console.error` for diagnostics.
- **Handlers must NOT return top-level `type` or `requestId` keys.** The dispatcher writes the NM-protocol envelope (`type:'result'`, `requestId`) over whatever the handler returned. (Caught by `EvalOutput.type` once — see commit `c0bde5d` for the lesson.)
- **TypeScript strict** with `noUncheckedIndexedAccess` and `verbatimModuleSyntax`. We don't relax these.
- **Commits**: conventional-ish prefix (`feat(extension):`, `fix(bridge):`, `docs:`, `chore:`). One-line summary + a paragraph explaining *why*, not just *what*. `Co-Authored-By:` lines welcome.
- **All commits stay in working tree green.** `bun run typecheck` must pass on every commit, no exceptions.

---

## What kinds of PRs are welcome

Open landing strips:

- **New tools** — `browser_set_cookies`, `browser_press_key`, `browser_scroll`, `browser_select`, `browser_get_html`, `browser_get_text`, `browser_print_pdf`, etc.
- **Long-operation streaming** — MCP `setStatus` progress for slow tools.
- **Chrome Web Store packaging** — so users don't have to sideload.
- **Session-handle incremental chunk collection** — resume interrupted `browser_read`.
- **containerTree structured output** — DOM-based output alternative for `browser_read`.

---

## Hard scope guardrails

byob has explicit non-goals. PRs that add these will be respectfully closed:

- **SaaS / cloud component.** byob makes zero outbound network calls; that stays.
- **In-page UI** (floating bubbles, sidebars, content-script-injected buttons). Users have an MCP client UI already.
- **Sandboxed LLM-code execution** (`sandbox.html`). `browser_eval` covers this with explicit opt-in.
- **Telemetry of any kind.** No usage metrics, no install pings, no crash uploads.

If you have an idea that touches these, open an issue first and let's discuss.

---

## Releasing

1. Bump versions in `shared/package.json`, `packages/*/package.json`, root `package.json`, `CHANGELOG.md`.
2. Run [`docs/e2e-checklist.md`](docs/e2e-checklist.md) by hand.
3. `git tag vX.Y.Z` and push.
4. (Eventually) `npm publish` the bridge + mcp-server packages.

---

## Testing philosophy

byob ships with no unit tests for cross-process logic on purpose — most bugs live at the protocol seams (CDP, Native Messaging, MCP) where mocks lie. Pure functions (`shared/src/*.ts`, `bridge/src/native-messaging.ts`, `bridge/src/extension-id.ts`) get focused `bun test` coverage; everything else is covered by the manual e2e checklist.

If you find a regression the e2e checklist misses, add the case to `docs/e2e-checklist.md` as part of the fix PR.

---

## Code of conduct

Be kind. The maintainer is one person reviewing PRs in spare time. A "what" + a "why" in your PR description gets you to merge faster than a fait accompli with no context.
