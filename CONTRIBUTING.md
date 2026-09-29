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
├── e2e/                   # Chrome-for-Testing harness, fixtures, end-to-end tests
├── scripts/               # build helpers, test preload
└── docs/                  # release checklist
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

- **Chrome Web Store packaging** — so users don't have to sideload.
- **Long-operation streaming** — MCP progress notifications for slow tools.
- **Screen recording** (tabCapture in the offscreen document) and visual screenshot diffs.
- **Snapshot heuristics** backed by a new fixture in `e2e/fixtures/` that shows the problem.

---

## Hard scope guardrails

byob has explicit non-goals. PRs that add these will be respectfully closed:

- **SaaS / cloud component.** byob makes zero outbound network calls; that stays.
- **In-page UI** (floating bubbles, sidebars, content-script-injected buttons). Users have an MCP client UI already.
- **Sandboxed LLM-code execution** (`sandbox.html`). `browser_evaluate` covers this with explicit opt-in.
- **Telemetry of any kind.** No usage metrics, no install pings, no crash uploads.

If you have an idea that touches these, open an issue first and let's discuss.

---

## Releasing

1. Bump versions in `shared/package.json`, `packages/*/package.json`, root `package.json`, `CHANGELOG.md`.
2. Run the automated tests, then the manual part of [`docs/e2e-checklist.md`](docs/e2e-checklist.md).
3. `git tag vX.Y.Z` and push.
4. (Eventually) `npm publish` the bridge + mcp-server packages.

---

## Testing

Three layers, all runnable locally:

```sh
bun run typecheck
bun test                              # unit tests: snapshot builder, diff, keyboard,
                                      # refs, in-page script escapes, schemas, bridge
BYOB_E2E=1 bun test e2e               # end to end, see below
```

The e2e suite launches **Chrome for Testing** with a separately built copy of
the extension (`packages/extension/output-e2e`), a bridge running under its own
`BYOB_HOME` (`~/.cache/byob-e2e/home`) and the real MCP server, then drives the
fixture pages in `e2e/fixtures/` through MCP exactly like an agent. It never
touches your own Chrome, extension build or `~/.byob`. One-time setup:
`bunx @puppeteer/browsers install chrome@stable --path ~/.cache/byob-e2e`.
`BYOB_E2E_HEADED=1` shows the browser; `BYOB_E2E_BUNDLE=1` tests the shipped
plugin bundle; `bun e2e/explore.ts '[["browser_snapshot",{}]]'` is a scratch
driver for poking at behaviour.

In-page scripts are shipped as source strings; `page-scripts.test.ts` checks
they parse and that no regex lost its backslash inside a template literal.
Add an e2e scenario (and a fixture) with every behavioural fix.

---

## Code of conduct

Be kind. The maintainer is one person reviewing PRs in spare time. A "what" + a "why" in your PR description gets you to merge faster than a fait accompli with no context.
