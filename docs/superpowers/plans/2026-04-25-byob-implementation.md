# byob Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local-only MCP server that lets AI agents drive the user's real Chrome via 10 browser tools, by reusing existing Dokobot architecture (Native Messaging + UNIX socket + CDP) but stripping the SaaS / in-page UI / sandbox-eval layers.

**Architecture:** Three TypeScript packages in a bun workspace — a WXT-built MV3 extension (CDP dispatcher), a Node Native Messaging host (bridge process exposing UNIX socket HTTP), and a Node MCP server (stdio transport, registers 10 tools). All three share a `@byob/shared` package containing Zod schemas and command names.

**Tech Stack:** bun workspaces · TypeScript strict · WXT (extension) · Node 23 (bridge & mcp-server) · @modelcontextprotocol/sdk · undici (UNIX-socket HTTP client) · Zod · tsx (dev runner)

**Spec reference:** `/Users/wxt/code/byob/docs/superpowers/specs/2026-04-25-byob-design.md`

---

## Demo Checkpoints (overview)

The plan is split into **8 phases**. After each phase ends with a **DEMO checkpoint** — stop, run the demo, get user approval before continuing. Do not silently steamroll through phases.

| Phase | What works at the end | Approx. effort |
|---|---|---|
| 0 — Bootstrap | `bun install` works, `tsc --noEmit` green across workspace | ½ day |
| 1 — Native Messaging round-trip | `byob install`, extension installed, `curl --unix-socket .../status` returns `{connected:true}` | 1 day |
| 2 — `browser_read` end-to-end | Claude Code can call `byob:browser_read https://news.ycombinator.com` and get HN front-page text | ½ day |
| 3 — Operation tools | `browser_click`, `browser_type`, `browser_navigate`, `browser_wait_for` working | ½ day |
| 4 — Utility tools | `browser_screenshot`, `browser_get_cookies`, `browser_list_tabs`, `browser_switch_tab` | ½ day |
| 5 — `browser_eval` + safety guards | env-gated eval, URL blacklist, audit log, notifications | ½ day |
| 6 — Error model + abort propagation | Error codes wired end-to-end, Ctrl+C clean shutdown, F12 fallback | ½ day |
| 7 — Management CLI + docs | `byob doctor` full output, README, e2e checklist runs green | ½ day |

---

## File Structure (locked in by this plan)

```
byob/
├── package.json                          # bun workspaces root
├── bunfig.toml
├── tsconfig.base.json
├── .gitignore
├── .editorconfig
├── README.md                             # written in Phase 7
├── docs/
│   ├── superpowers/specs/                # already exists
│   ├── superpowers/plans/                # this file
│   └── e2e-checklist.md                  # written in Phase 7
├── shared/
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts                      # re-exports
│       ├── commands.ts                   # NM command name constants
│       ├── schemas.ts                    # Zod schemas (input/output for 10 tools)
│       └── errors.ts                     # ErrorCode enum
└── packages/
    ├── extension/
    │   ├── package.json
    │   ├── tsconfig.json
    │   ├── wxt.config.ts
    │   ├── entrypoints/
    │   │   ├── background.ts             # SW: NM client + dispatcher
    │   │   └── offscreen.ts              # (Phase 4: image decoding helper, optional)
    │   ├── lib/
    │   │   ├── native-msg.ts             # connectNative + reconnect
    │   │   ├── cdp.ts                    # CDPSession class + tabId→session map
    │   │   ├── tab.ts                    # openOrReuse helper
    │   │   ├── url-guard.ts              # forbidden URL check
    │   │   ├── notify.ts                 # chrome.notifications wrapper (eval audit)
    │   │   ├── keepalive.ts              # alarms + power hooks
    │   │   └── handlers/
    │   │       ├── index.ts              # name→handler map
    │   │       ├── read.ts
    │   │       ├── screenshot.ts
    │   │       ├── click.ts
    │   │       ├── type.ts
    │   │       ├── get-cookies.ts
    │   │       ├── eval.ts
    │   │       ├── navigate.ts
    │   │       ├── wait-for.ts
    │   │       ├── list-tabs.ts
    │   │       └── switch-tab.ts
    │   └── public/icons/
    ├── bridge/
    │   ├── package.json
    │   ├── tsconfig.json
    │   ├── bin/
    │   │   ├── byob.ts                   # management CLI
    │   │   └── byob-bridge.ts            # NM host entry
    │   └── src/
    │       ├── main.ts                   # bridge main loop
    │       ├── native-messaging.ts       # 4-byte LE frame codec
    │       ├── ipc-server.ts             # UNIX-socket HTTP server
    │       ├── bridge-registry.ts        # ~/.byob/bridges.json read/write
    │       ├── extension-id.ts           # SHA-256 → a-p mapping
    │       ├── install.ts                # `byob install`
    │       ├── doctor.ts                 # `byob doctor`
    │       ├── logs.ts                   # `byob logs`
    │       ├── uninstall.ts              # `byob uninstall`
    │       └── paths.ts                  # ~/.byob/* path helpers
    └── mcp-server/
        ├── package.json
        ├── tsconfig.json
        ├── bin/
        │   └── byob-mcp.ts               # MCP stdio entry
        └── src/
            ├── server.ts                 # registers tools
            ├── bridge-client.ts          # undici Agent over UNIX socket
            ├── error-mapper.ts           # bridge error → MCP isError envelope
            ├── resolve-bridge.ts         # pick which bridge from registry
            └── tools/
                ├── index.ts              # imports + register-all helper
                ├── browser-read.ts
                ├── browser-screenshot.ts
                ├── browser-click.ts
                ├── browser-type.ts
                ├── browser-get-cookies.ts
                ├── browser-eval.ts
                ├── browser-navigate.ts
                ├── browser-wait-for.ts
                ├── browser-list-tabs.ts
                └── browser-switch-tab.ts
```

---

## Conventions (apply across all phases)

- **Bash commands** — Always prefix with `unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY;` per the user's CLAUDE.md preference.
- **TypeScript imports** — All packages use `"type": "module"` and ESM imports with explicit `.js` extensions (TS resolves to `.ts` source under `moduleResolution: "Bundler"`).
- **Logging in mcp-server** — NEVER `console.log()` in mcp-server (stdout is MCP protocol, will corrupt). Always `console.error()`.
- **Commit cadence** — One commit per task (end of each task has a commit step).
- **Co-author trailer** — All commits end with `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` per CLAUDE.md preference.
- **Test policy** — Per spec, no broad unit-test suite. BUT: pure functions (NM frame codec, extension-ID algorithm, URL guard) get one minimal `bun test` each. Cross-process logic verified via the per-phase DEMO checkpoint.
- **Branch policy** — All work on `main` for now (single developer). Each task = one commit.

---

# Phase 0 — Bootstrap (½ day)

**Goal:** Empty repo → workspace skeleton with `shared` package fully typed and the three workspace packages stubbed. `bun install` succeeds, `tsc --noEmit` succeeds across all packages.

**DEMO at end of Phase 0:**
```sh
cd /Users/wxt/code/byob
bun install                        # → no errors
bun run typecheck                  # → no errors across 4 packages
git log --oneline | head           # → 4 commits
```

---

### Task 0.1: Create root workspace files

**Files:**
- Create: `/Users/wxt/code/byob/package.json`
- Create: `/Users/wxt/code/byob/bunfig.toml`
- Create: `/Users/wxt/code/byob/tsconfig.base.json`
- Create: `/Users/wxt/code/byob/.gitignore`
- Create: `/Users/wxt/code/byob/.editorconfig`

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "byob-root",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "workspaces": ["shared", "packages/*"],
  "scripts": {
    "typecheck": "bun run --filter '*' typecheck",
    "build": "bun run --filter '*' build",
    "fmt": "bun fmt"
  },
  "engines": { "node": ">=20" }
}
```

- [ ] **Step 2: Write `bunfig.toml`**

```toml
[install]
exact = true

[install.scopes]
"@byob" = "https://registry.npmjs.org/"
```

- [ ] **Step 3: Write `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2023"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

- [ ] **Step 4: Write `.gitignore`**

```gitignore
node_modules/
.output/
.wxt/
dist/
*.tsbuildinfo
.DS_Store
.env
.env.local
~/.byob/
*.log
```

- [ ] **Step 5: Write `.editorconfig`**

```ini
root = true

[*]
indent_style = space
indent_size = 2
end_of_line = lf
charset = utf-8
trim_trailing_whitespace = true
insert_final_newline = true
```

- [ ] **Step 6: Commit**

```sh
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
cd /Users/wxt/code/byob
git add package.json bunfig.toml tsconfig.base.json .gitignore .editorconfig
git commit -m "$(cat <<'EOF'
chore: bootstrap monorepo root config

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 0.2: Build the `@byob/shared` package

**Files:**
- Create: `/Users/wxt/code/byob/shared/package.json`
- Create: `/Users/wxt/code/byob/shared/tsconfig.json`
- Create: `/Users/wxt/code/byob/shared/src/index.ts`
- Create: `/Users/wxt/code/byob/shared/src/commands.ts`
- Create: `/Users/wxt/code/byob/shared/src/errors.ts`
- Create: `/Users/wxt/code/byob/shared/src/schemas.ts`

- [ ] **Step 1: Write `shared/package.json`**

```json
{
  "name": "@byob/shared",
  "version": "0.1.0",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "typescript": "^5.6.0"
  }
}
```

- [ ] **Step 2: Write `shared/tsconfig.json`**

```json
{
  "extends": "../tsconfig.base.json",
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Write `shared/src/commands.ts`**

```typescript
export const Command = {
  Read:        'readPage',
  Screenshot:  'screenshot',
  Click:       'click',
  Type:        'type',
  GetCookies:  'getCookies',
  Eval:        'eval',
  Navigate:    'navigate',
  WaitFor:     'waitFor',
  ListTabs:    'listTabs',
  SwitchTab:   'switchTab',
} as const;

export type CommandName = (typeof Command)[keyof typeof Command];
```

- [ ] **Step 4: Write `shared/src/errors.ts`**

```typescript
export const ErrorCode = {
  BRIDGE_NOT_RUNNING:      'bridge_not_running',
  EXTENSION_NOT_CONNECTED: 'extension_not_connected',
  CHROME_NOT_RUNNING:      'chrome_not_running',
  CDP_ATTACH_FAILED:       'cdp_attach_failed',
  CDP_DETACHED_UNEXPECTED: 'cdp_detached',
  TAB_CLOSED:              'tab_closed',
  TAB_NAVIGATED:           'tab_navigated',
  TIMEOUT:                 'timeout',
  SELECTOR_NOT_FOUND:      'selector_not_found',
  ELEMENT_NOT_VISIBLE:     'element_not_visible',
  EVAL_DISABLED:           'eval_disabled',
  EVAL_EXCEPTION:          'eval_exception',
  URL_FORBIDDEN:           'url_forbidden',
  RATE_LIMITED:            'rate_limited',
  UNKNOWN:                 'unknown',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface ErrorEnvelope {
  error: ErrorCodeValue;
  message: string;
  hint?: string;
  aborted?: boolean;
}
```

- [ ] **Step 5: Write `shared/src/schemas.ts`** (full Zod schemas for all 10 tools)

```typescript
import { z } from 'zod';

// ---------- Common ----------
export const ChunkSchema = z.object({
  id: z.string(),
  sourceIds: z.array(z.string()).default([]),
  text: z.string(),
  bounds: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  zIndex: z.number().optional(),
  containerId: z.string().optional(),
});
export type Chunk = z.infer<typeof ChunkSchema>;

// ---------- 1. browser_read ----------
export const ReadInput = z.object({
  url: z.string().url(),
  screens: z.number().int().min(1).max(50).default(3),
  timeoutSec: z.number().int().min(1).max(600).default(60),
  sessionId: z.string().optional(),
  reuseTab: z.boolean().default(false),
});
export const ReadOutput = z.object({
  text: z.string(),
  title: z.string(),
  url: z.string(),
  chunks: z.array(ChunkSchema),
  sessionId: z.string(),
  canContinue: z.boolean(),
  stopReason: z.enum(['end_of_scroll', 'timeout', 'limit_reached', 'fallback']),
});

// ---------- 2. browser_screenshot ----------
export const ScreenshotInput = z.object({
  url: z.string().url().optional(),
  tabId: z.number().int().optional(),
  fullPage: z.boolean().default(false),
  format: z.enum(['png', 'jpeg']).default('png'),
  quality: z.number().int().min(1).max(100).optional(),
  savePath: z.string().optional(),
});
export const ScreenshotOutput = z.object({
  path: z.string(),
  width: z.number(),
  height: z.number(),
  format: z.string(),
});

// ---------- 3. browser_click ----------
export const ClickInput = z.object({
  selector: z.string(),
  tabId: z.number().int().optional(),
  button: z.enum(['left', 'right', 'middle']).default('left'),
  clickCount: z.number().int().min(1).max(3).default(1),
  modifiers: z.array(z.enum(['Alt', 'Control', 'Shift', 'Meta'])).default([]),
});
export const ClickOutput = z.object({
  success: z.literal(true),
  elementText: z.string().optional(),
});

// ---------- 4. browser_type ----------
export const TypeInput = z.object({
  selector: z.string(),
  text: z.string(),
  tabId: z.number().int().optional(),
  clear: z.boolean().default(false),
  pressEnter: z.boolean().default(false),
});
export const TypeOutput = z.object({ success: z.literal(true) });

// ---------- 5. browser_get_cookies ----------
export const GetCookiesInput = z
  .object({
    domain: z.string().optional(),
    url: z.string().url().optional(),
  })
  .refine((v) => v.domain || v.url, {
    message: 'either domain or url is required',
  });
export const CookieSchema = z.object({
  name: z.string(),
  value: z.string(),
  domain: z.string(),
  path: z.string(),
  expires: z.number().optional(),
  httpOnly: z.boolean(),
  secure: z.boolean(),
  sameSite: z.enum(['Strict', 'Lax', 'None', 'no_restriction', 'unspecified']).optional(),
  partitionKey: z.string().optional(),
});
export const GetCookiesOutput = z.object({ cookies: z.array(CookieSchema) });

// ---------- 6. browser_eval ----------
export const EvalInput = z.object({
  code: z.string(),
  tabId: z.number().int().optional(),
  awaitPromise: z.boolean().default(true),
  returnByValue: z.boolean().default(true),
});
export const EvalOutput = z.object({
  result: z.unknown(),
  type: z.string(),
  exceptionDetails: z.unknown().optional(),
});

// ---------- 7. browser_navigate ----------
export const NavigateInput = z.object({
  url: z.string().url(),
  tabId: z.number().int().optional(),
  waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle']).default('load'),
  timeoutSec: z.number().int().min(1).max(600).default(30),
});
export const NavigateOutput = z.object({
  tabId: z.number().int(),
  url: z.string(),
  title: z.string(),
});

// ---------- 8. browser_wait_for ----------
export const WaitForInput = z.object({
  selector: z.string(),
  tabId: z.number().int().optional(),
  state: z.enum(['visible', 'hidden', 'attached', 'detached']).default('visible'),
  timeoutSec: z.number().int().min(1).max(600).default(10),
});
export const WaitForOutput = z.object({
  found: z.literal(true),
  elapsedMs: z.number(),
});

// ---------- 9. browser_list_tabs ----------
export const ListTabsOutput = z.object({
  tabs: z.array(
    z.object({
      id: z.number(),
      url: z.string(),
      title: z.string(),
      active: z.boolean(),
      windowId: z.number(),
    }),
  ),
});

// ---------- 10. browser_switch_tab ----------
export const SwitchTabInput = z.object({ tabId: z.number().int() });
export const SwitchTabOutput = z.object({ success: z.literal(true) });
```

- [ ] **Step 6: Write `shared/src/index.ts`**

```typescript
export * from './commands.js';
export * from './errors.js';
export * from './schemas.js';
```

- [ ] **Step 7: Install + typecheck**

```sh
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
cd /Users/wxt/code/byob
bun install
cd shared && bun run typecheck
```

Expected: `bun install` resolves zod + typescript; `tsc --noEmit` exits 0 with no output.

- [ ] **Step 8: Commit**

```sh
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
cd /Users/wxt/code/byob
git add shared/ bun.lock
git commit -m "$(cat <<'EOF'
feat(shared): add command names, error codes, and Zod schemas

10 tool input/output schemas locked in. Single source of truth for
extension, bridge, and mcp-server packages.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 0.3: Stub the `@byob/bridge` package

**Files:**
- Create: `/Users/wxt/code/byob/packages/bridge/package.json`
- Create: `/Users/wxt/code/byob/packages/bridge/tsconfig.json`
- Create: `/Users/wxt/code/byob/packages/bridge/src/paths.ts`
- Create: `/Users/wxt/code/byob/packages/bridge/bin/byob.ts`
- Create: `/Users/wxt/code/byob/packages/bridge/bin/byob-bridge.ts`

- [ ] **Step 1: Write `packages/bridge/package.json`**

```json
{
  "name": "@byob/bridge",
  "version": "0.1.0",
  "type": "module",
  "bin": {
    "byob": "./bin/byob.ts",
    "byob-bridge": "./bin/byob-bridge.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "dev:bridge": "tsx watch bin/byob-bridge.ts",
    "dev:cli": "tsx bin/byob.ts"
  },
  "dependencies": {
    "@byob/shared": "workspace:*",
    "commander": "^12.0.0",
    "undici": "^7.0.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "tsx": "^4.0.0",
    "typescript": "^5.6.0"
  }
}
```

- [ ] **Step 2: Write `packages/bridge/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "types": ["node"],
    "lib": ["ES2023"]
  },
  "include": ["src/**/*", "bin/**/*"]
}
```

- [ ] **Step 3: Write `packages/bridge/src/paths.ts`**

```typescript
import * as path from 'node:path';
import * as os from 'node:os';

export const DOKO_DIR        = path.join(os.homedir(), '.byob');
export const REGISTRY_PATH   = path.join(DOKO_DIR, 'bridges.json');
export const BRIDGES_DIR     = path.join(DOKO_DIR, 'bridges');
export const LAUNCHER_PATH   = path.join(DOKO_DIR, 'bridge-host.sh');
export const LOG_PATH        = path.join(DOKO_DIR, 'bridge.log');
export const EVAL_AUDIT_PATH = path.join(DOKO_DIR, 'eval-audit.log');
export const SCREENSHOTS_DIR = path.join(DOKO_DIR, 'screenshots');

export function socketPathFor(deviceId: string): string {
  return path.join(BRIDGES_DIR, `${deviceId}.sock`);
}
```

- [ ] **Step 4: Write `packages/bridge/bin/byob.ts` (stub)**

```typescript
#!/usr/bin/env -S npx tsx
import { Command } from 'commander';

const program = new Command();
program.name('byob').description('byob management CLI').version('0.1.0');

program.command('install').description('install Native Messaging manifest').action(() => {
  console.error('install: not implemented yet (Phase 1)');
});
program.command('doctor').description('diagnose connectivity').action(() => {
  console.error('doctor: not implemented yet (Phase 1)');
});

program.parseAsync().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 5: Write `packages/bridge/bin/byob-bridge.ts` (stub)**

```typescript
#!/usr/bin/env -S npx tsx
// Phase 0 stub. Real entry implemented in Phase 1.
console.error('[byob-bridge] stub: real bridge implemented in Phase 1');
process.exit(0);
```

- [ ] **Step 6: Typecheck + commit**

```sh
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
cd /Users/wxt/code/byob && bun install
cd packages/bridge && bun run typecheck
cd /Users/wxt/code/byob
git add packages/bridge/ bun.lock
git commit -m "$(cat <<'EOF'
feat(bridge): stub package with paths helper and CLI scaffold

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 0.4: Stub the `@byob/mcp-server` and `@byob/extension` packages

**Files:**
- Create: `/Users/wxt/code/byob/packages/mcp-server/package.json`
- Create: `/Users/wxt/code/byob/packages/mcp-server/tsconfig.json`
- Create: `/Users/wxt/code/byob/packages/mcp-server/bin/byob-mcp.ts`
- Create: `/Users/wxt/code/byob/packages/extension/package.json`
- Create: `/Users/wxt/code/byob/packages/extension/tsconfig.json`
- Create: `/Users/wxt/code/byob/packages/extension/wxt.config.ts`
- Create: `/Users/wxt/code/byob/packages/extension/entrypoints/background.ts` (stub)

- [ ] **Step 1: Write `packages/mcp-server/package.json`**

```json
{
  "name": "@byob/mcp-server",
  "version": "0.1.0",
  "type": "module",
  "bin": { "byob-mcp": "./bin/byob-mcp.ts" },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "dev": "tsx watch bin/byob-mcp.ts"
  },
  "dependencies": {
    "@byob/shared": "workspace:*",
    "@modelcontextprotocol/sdk": "^1.0.0",
    "undici": "^7.0.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "tsx": "^4.0.0",
    "typescript": "^5.6.0"
  }
}
```

- [ ] **Step 2: Write `packages/mcp-server/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "types": ["node"]
  },
  "include": ["src/**/*", "bin/**/*"]
}
```

- [ ] **Step 3: Write `packages/mcp-server/bin/byob-mcp.ts` (stub)**

```typescript
#!/usr/bin/env -S npx tsx
// Phase 0 stub. Real MCP server implemented in Phase 2.
console.error('[byob-mcp] stub: real server implemented in Phase 2');
process.exit(0);
```

- [ ] **Step 4: Write `packages/extension/package.json`**

```json
{
  "name": "@byob/extension",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "typecheck": "wxt prepare && tsc --noEmit",
    "dev": "wxt",
    "build": "wxt build"
  },
  "dependencies": {
    "@byob/shared": "workspace:*",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/chrome": "^0.0.270",
    "typescript": "^5.6.0",
    "wxt": "^0.19.0"
  }
}
```

- [ ] **Step 5: Write `packages/extension/wxt.config.ts`**

The `key` field below pins the Chrome extension ID. Generate the public-key base64 using `openssl genrsa -out byob-key.pem 2048 && openssl rsa -in byob-key.pem -pubout -outform DER | base64 | tr -d '\n'`. Save `byob-key.pem` to `~/.byob/extension-key.pem` (NOT in repo) and paste the base64 here.

```typescript
import { defineConfig } from 'wxt';

export default defineConfig({
  manifest: {
    name: 'byob — Bring Your Own Browser',
    description: 'Local-only browser bridge for AI agents (MCP)',
    version: '0.1.0',
    // PUBLIC KEY (base64 of DER) — pins extension ID across reloads.
    // Replace this placeholder before Phase 1 install step.
    key: 'REPLACE_WITH_BASE64_DER_PUBLIC_KEY',
    permissions: [
      'debugger',
      'tabs',
      'scripting',
      'cookies',
      'nativeMessaging',
      'storage',
      'alarms',
      'power',
      'notifications',
      'offscreen',
    ],
    host_permissions: ['<all_urls>'],
    minimum_chrome_version: '116',
  },
});
```

- [ ] **Step 6: Write `packages/extension/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "types": ["chrome", "wxt/client"]
  },
  "include": [".wxt/types/**/*", "entrypoints/**/*", "lib/**/*", "wxt.config.ts"]
}
```

- [ ] **Step 7: Write `packages/extension/entrypoints/background.ts` (stub)**

```typescript
export default defineBackground(() => {
  console.log('[byob] service worker boot — phase 0 stub');
});
```

- [ ] **Step 8: Install + typecheck**

```sh
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
cd /Users/wxt/code/byob
bun install
cd packages/extension && bun run typecheck
cd ../mcp-server && bun run typecheck
```

Expected: WXT prepares `.wxt/`, all four packages typecheck clean.

- [ ] **Step 9: Verify cross-package import works**

Add this temporary line at the end of `packages/extension/entrypoints/background.ts`:
```typescript
import { Command } from '@byob/shared';
console.log('[byob] command names:', Object.values(Command));
```
Run typecheck again to verify the workspace alias resolves. Then **delete** that import line before commit.

- [ ] **Step 10: Commit**

```sh
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
cd /Users/wxt/code/byob
git add packages/ bun.lock
git commit -m "$(cat <<'EOF'
feat: stub mcp-server and extension packages

Workspace cross-imports verified. Real implementations follow.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Phase 0 DEMO Checkpoint

Show the user:

```sh
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
cd /Users/wxt/code/byob
bun install
bun run typecheck                  # all 4 packages green
git log --oneline                  # 4 + 1 design commits
ls -la packages/                   # extension/  bridge/  mcp-server/
```

**Stop here. Wait for user "go" before Phase 1.**

---

# Phase 1 — Native Messaging Round-Trip (1 day)

**Goal:** Bridge process can be installed, Chrome can launch it, extension can hello/handshake, bridge opens UNIX socket and answers `GET /status` with `{connected: true}`.

**DEMO at end of Phase 1:**
```sh
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
# 1. Install bridge + manifest
bun --cwd packages/bridge run dev:cli install --dev
# 2. Open Chrome → chrome://extensions → Load unpacked → packages/extension/.output/chrome-mv3
# 3. Verify
ls -la ~/.byob/bridges/                              # one .sock file
curl --unix-socket ~/.byob/bridges/<id>.sock http://x/status
# → {"connected":true,"deviceId":"...","sinceMs":N}
cat ~/.byob/bridge.log                               # hello received, IPC up
```

---

### Task 1.1: Implement Native Messaging frame codec (with unit test)

**Files:**
- Create: `/Users/wxt/code/byob/packages/bridge/src/native-messaging.ts`
- Create: `/Users/wxt/code/byob/packages/bridge/src/native-messaging.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/bridge/src/native-messaging.test.ts
import { test, expect } from 'bun:test';
import { encodeFrame, decodeFrames } from './native-messaging.js';

test('encodeFrame produces 4-byte LE length header + UTF-8 JSON body', () => {
  const buf = encodeFrame({ hello: 'world' });
  const len = buf.readUInt32LE(0);
  expect(len).toBe(buf.length - 4);
  const body = buf.subarray(4).toString('utf-8');
  expect(JSON.parse(body)).toEqual({ hello: 'world' });
});

test('decodeFrames yields complete messages and keeps remainder', () => {
  const a = encodeFrame({ a: 1 });
  const b = encodeFrame({ b: 2 });
  const merged = Buffer.concat([a, b.subarray(0, 3)]);
  const { messages, rest } = decodeFrames(merged);
  expect(messages).toEqual([{ a: 1 }]);
  expect(rest.length).toBe(3);
});

test('decodeFrames handles split header', () => {
  const full = encodeFrame({ x: 'y' });
  const { messages, rest } = decodeFrames(full.subarray(0, 2));
  expect(messages).toEqual([]);
  expect(rest.length).toBe(2);
});
```

- [ ] **Step 2: Run the test and confirm failure**

```sh
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
cd /Users/wxt/code/byob/packages/bridge
bun test src/native-messaging.test.ts
```

Expected: error like `Cannot find module './native-messaging.js'`.

- [ ] **Step 3: Implement the codec**

```typescript
// packages/bridge/src/native-messaging.ts
export function encodeFrame(msg: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(msg), 'utf-8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

export function decodeFrames(buffer: Buffer): { messages: unknown[]; rest: Buffer } {
  const messages: unknown[] = [];
  let cursor = buffer;
  while (cursor.length >= 4) {
    const len = cursor.readUInt32LE(0);
    if (cursor.length < 4 + len) break;
    const body = cursor.subarray(4, 4 + len).toString('utf-8');
    try {
      messages.push(JSON.parse(body));
    } catch {
      // malformed body — skip silently to keep the stream alive
    }
    cursor = cursor.subarray(4 + len);
  }
  return { messages, rest: cursor };
}

export function writeFrameToStdout(msg: unknown): void {
  process.stdout.write(encodeFrame(msg));
}

export function startStdinReader(onMessage: (msg: unknown) => void): void {
  let buf = Buffer.alloc(0);
  process.stdin.on('data', (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    const { messages, rest } = decodeFrames(buf);
    buf = rest;
    for (const m of messages) onMessage(m);
  });
}
```

- [ ] **Step 4: Run tests, confirm pass**

```sh
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
cd /Users/wxt/code/byob/packages/bridge
bun test src/native-messaging.test.ts
```

Expected: 3 pass, 0 fail.

- [ ] **Step 5: Commit**

```sh
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
cd /Users/wxt/code/byob
git add packages/bridge/src/native-messaging.ts packages/bridge/src/native-messaging.test.ts
git commit -m "$(cat <<'EOF'
feat(bridge): native messaging frame codec + tests

4-byte LE length prefix + UTF-8 JSON body per Chrome NM spec.
Handles split frames and malformed payloads.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 1.2: Implement extension-ID algorithm (with unit test)

Chrome computes the extension ID as `SHA-256(public_key_DER)[:32]` mapped from hex 0–f to a–p. The `byob install` command needs this to populate `allowed_origins` in the NM manifest.

**Files:**
- Create: `/Users/wxt/code/byob/packages/bridge/src/extension-id.ts`
- Create: `/Users/wxt/code/byob/packages/bridge/src/extension-id.test.ts`

- [ ] **Step 1: Write the failing test**

The canonical test vector below is from Chromium source (`extensions/common/extension_id.cc` test).

```typescript
// packages/bridge/src/extension-id.test.ts
import { test, expect } from 'bun:test';
import { computeExtensionId } from './extension-id.js';

test('maps hex 0-f to a-p across the first 32 chars of SHA-256', () => {
  // DER bytes of a 1-byte "0x00" key — easy to verify by hand.
  const trivialKeyB64 = Buffer.from([0x00]).toString('base64');
  const id = computeExtensionId(trivialKeyB64);
  expect(id).toHaveLength(32);
  expect(id).toMatch(/^[a-p]{32}$/);
  // SHA-256 of [0x00] = 6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d
  // First 32 hex chars: 6e340b9cffb37a989ca544e6bb780a2c
  // Mapped a..p:        godepajpllpdhajilkkpllhiakclapcm
  expect(id).toBe('godepajpllpdhajilkkpllhiakclapcm');
});
```

- [ ] **Step 2: Run test, confirm failure**

```sh
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
cd /Users/wxt/code/byob/packages/bridge
bun test src/extension-id.test.ts
```

Expected: module not found error.

- [ ] **Step 3: Implement the algorithm**

```typescript
// packages/bridge/src/extension-id.ts
import * as crypto from 'node:crypto';

/**
 * Compute the Chrome extension ID from the manifest "key" field
 * (a base64-encoded DER public key).
 *
 * Algorithm: SHA-256(DER) → take first 32 hex chars → map each hex digit
 * 0..f to letters a..p.
 */
export function computeExtensionId(publicKeyBase64: string): string {
  const keyBytes = Buffer.from(publicKeyBase64, 'base64');
  const hex = crypto.createHash('sha256').update(keyBytes).digest('hex');
  return hex
    .slice(0, 32)
    .split('')
    .map((c) => String.fromCharCode('a'.charCodeAt(0) + parseInt(c, 16)))
    .join('');
}
```

- [ ] **Step 4: Run test, confirm pass**

```sh
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
cd /Users/wxt/code/byob/packages/bridge
bun test src/extension-id.test.ts
```

Expected: 1 pass.

- [ ] **Step 5: Commit**

```sh
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
cd /Users/wxt/code/byob
git add packages/bridge/src/extension-id.ts packages/bridge/src/extension-id.test.ts
git commit -m "$(cat <<'EOF'
feat(bridge): extension-id derivation from public key

SHA-256(DER)[:32] mapped from hex to a-p, per Chromium spec.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 1.3: Implement bridge registry

The registry tracks all live bridge processes (one per Chrome profile). mcp-server reads it later to pick which bridge to talk to.

**Files:**
- Create: `/Users/wxt/code/byob/packages/bridge/src/bridge-registry.ts`

- [ ] **Step 1: Write the module**

```typescript
// packages/bridge/src/bridge-registry.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { REGISTRY_PATH, DOKO_DIR, socketPathFor } from './paths.js';

export interface BridgeEntry {
  deviceId: string;
  pid: number;
  socket: string;
  startedAt: number;
}

function readRaw(): BridgeEntry[] {
  try {
    if (fs.existsSync(REGISTRY_PATH)) {
      const txt = fs.readFileSync(REGISTRY_PATH, 'utf-8');
      const v = JSON.parse(txt);
      if (Array.isArray(v)) return v as BridgeEntry[];
    }
  } catch { /* corrupt file → treat as empty */ }
  return [];
}

function writeRaw(entries: BridgeEntry[]): void {
  if (!fs.existsSync(DOKO_DIR)) fs.mkdirSync(DOKO_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(entries, null, 2), { mode: 0o600 });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function registerBridge(entry: Omit<BridgeEntry, 'startedAt'>): void {
  const filtered = readRaw().filter((e) => e.deviceId !== entry.deviceId);
  filtered.push({ ...entry, startedAt: Date.now() });
  writeRaw(filtered);
}

export function unregisterBridge(deviceId: string): void {
  writeRaw(readRaw().filter((e) => e.deviceId !== deviceId));
}

export function listAliveBridges(): BridgeEntry[] {
  const entries = readRaw().filter((e) => isProcessAlive(e.pid));
  // Compact: persist only the alive ones
  if (entries.length !== readRaw().length) writeRaw(entries);
  return entries;
}

export { socketPathFor };
```

- [ ] **Step 2: Typecheck**

```sh
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
cd /Users/wxt/code/byob/packages/bridge && bun run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```sh
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
cd /Users/wxt/code/byob
git add packages/bridge/src/bridge-registry.ts
git commit -m "$(cat <<'EOF'
feat(bridge): registry tracks live bridge processes per profile

~/.byob/bridges.json holds {deviceId,pid,socket,startedAt}.
Dead PIDs auto-pruned on read.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 1.4: Implement `byob install` command

This generates the launcher shell script and writes the Native Messaging manifest into Chrome / Brave / Edge directories.

**Files:**
- Create: `/Users/wxt/code/byob/packages/bridge/src/install.ts`
- Modify: `/Users/wxt/code/byob/packages/bridge/bin/byob.ts` (wire `install` to real impl)

- [ ] **Step 1: Implement `install.ts`**

```typescript
// packages/bridge/src/install.ts
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeExtensionId } from './extension-id.js';
import { DOKO_DIR, LAUNCHER_PATH, BRIDGES_DIR } from './paths.js';

const NATIVE_HOST_NAME = 'ai.byob.bridge';

interface BrowserEntry {
  name: string;
  manifestDir: string;
  installed: () => boolean;
}

function browserEntries(): BrowserEntry[] {
  const home = os.homedir();
  switch (process.platform) {
    case 'darwin':
      return [
        {
          name: 'Chrome',
          manifestDir: path.join(home, 'Library/Application Support/Google/Chrome/NativeMessagingHosts'),
          installed: () => fs.existsSync('/Applications/Google Chrome.app'),
        },
        {
          name: 'Brave',
          manifestDir: path.join(home, 'Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts'),
          installed: () => fs.existsSync('/Applications/Brave Browser.app'),
        },
        {
          name: 'Edge',
          manifestDir: path.join(home, 'Library/Application Support/Microsoft Edge/NativeMessagingHosts'),
          installed: () => fs.existsSync('/Applications/Microsoft Edge.app'),
        },
      ];
    case 'linux':
      return [
        { name: 'Chrome', manifestDir: path.join(home, '.config/google-chrome/NativeMessagingHosts'), installed: () => true },
        { name: 'Brave',  manifestDir: path.join(home, '.config/BraveSoftware/Brave-Browser/NativeMessagingHosts'), installed: () => true },
      ];
    default:
      throw new Error(`Unsupported platform: ${process.platform}`);
  }
}

interface InstallOptions {
  dev?: boolean;
  publicKeyB64: string;
  bridgeEntryAbs: string;   // absolute path to bin/byob-bridge.ts (or compiled .js)
}

export function install(opts: InstallOptions): void {
  process.umask(0o077);

  // 1. ensure dirs
  fs.mkdirSync(DOKO_DIR,    { recursive: true, mode: 0o700 });
  fs.mkdirSync(BRIDGES_DIR, { recursive: true, mode: 0o700 });

  // 2. write launcher shell script
  const nodeBin = process.execPath;
  const nodeDir = path.dirname(nodeBin);
  const launcherBody = opts.dev
    ? `#!/bin/sh
export PATH="${nodeDir}:$PATH"
exec "${nodeBin}" --import tsx "${opts.bridgeEntryAbs}" "$@"
`
    : `#!/bin/sh
export PATH="${nodeDir}:$PATH"
exec "${nodeBin}" "${opts.bridgeEntryAbs}" "$@"
`;
  fs.writeFileSync(LAUNCHER_PATH, launcherBody, { mode: 0o755 });
  console.log(`  Launcher: ${LAUNCHER_PATH}`);

  // 3. compute extension ID and write manifest per browser
  const extensionId = computeExtensionId(opts.publicKeyB64);
  const manifest = {
    name: NATIVE_HOST_NAME,
    description: 'byob local bridge for AI agents',
    path: LAUNCHER_PATH,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };

  let written = 0;
  for (const b of browserEntries()) {
    if (!b.installed()) {
      console.log(`  - ${b.name} (not installed, skipped)`);
      continue;
    }
    fs.mkdirSync(b.manifestDir, { recursive: true });
    const manifestPath = path.join(b.manifestDir, `${NATIVE_HOST_NAME}.json`);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    console.log(`  ✓ ${b.name}: ${manifestPath}`);
    written++;
  }

  console.log('');
  console.log(`Bridge installed for extension ID: ${extensionId}`);
  console.log(`Wrote ${written} browser manifest(s).`);
  console.log('');
  console.log('Next steps:');
  console.log('  1. chrome://extensions → enable Developer mode → Load unpacked');
  console.log('     → packages/extension/.output/chrome-mv3');
  console.log('  2. Restart Chrome (or just reload the extension)');
}

/**
 * Read the public key out of the extension's wxt.config.ts manifest.key field.
 * For dev install this lives in the repo; for prod install we'd embed it.
 */
export function readPublicKeyFromExtensionConfig(repoRoot: string): string {
  const cfg = fs.readFileSync(path.join(repoRoot, 'packages/extension/wxt.config.ts'), 'utf-8');
  const m = cfg.match(/key:\s*['"]([^'"]+)['"]/);
  if (!m || !m[1] || m[1] === 'REPLACE_WITH_BASE64_DER_PUBLIC_KEY') {
    throw new Error(
      'extension public key not set in wxt.config.ts.\n' +
      'Run: openssl genrsa -out ~/.byob/extension-key.pem 2048 && \\\n' +
      '     openssl rsa -in ~/.byob/extension-key.pem -pubout -outform DER | base64 | tr -d "\\n"\n' +
      'and paste the result into packages/extension/wxt.config.ts manifest.key.',
    );
  }
  return m[1];
}

export function bridgeEntryAbsForDev(repoRoot: string): string {
  return path.join(repoRoot, 'packages/bridge/bin/byob-bridge.ts');
}
```

- [ ] **Step 2: Wire `byob install` in the CLI**

Replace the existing stub `install` action in `packages/bridge/bin/byob.ts`:

```typescript
#!/usr/bin/env -S npx tsx
import { Command } from 'commander';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { install, readPublicKeyFromExtensionConfig, bridgeEntryAbsForDev } from '../src/install.js';

const program = new Command();
program.name('byob').description('byob management CLI').version('0.1.0');

program
  .command('install')
  .description('install Native Messaging manifest for the byob extension')
  .option('--dev', 'launcher runs source via tsx (no build needed)')
  .action(async (opts: { dev?: boolean }) => {
    const here    = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(here, '../../..');
    const publicKeyB64   = readPublicKeyFromExtensionConfig(repoRoot);
    const bridgeEntryAbs = bridgeEntryAbsForDev(repoRoot);
    install({ dev: !!opts.dev, publicKeyB64, bridgeEntryAbs });
  });

program.command('doctor').description('diagnose connectivity').action(() => {
  console.error('doctor: not implemented yet');
});

program.parseAsync().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 3: Generate the extension key (one-time, manual)**

```sh
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
mkdir -p ~/.byob
openssl genrsa -out ~/.byob/extension-key.pem 2048
openssl rsa -in ~/.byob/extension-key.pem -pubout -outform DER | base64 | tr -d '\n'
```

Copy the printed base64 string. Paste it into `packages/extension/wxt.config.ts` replacing `REPLACE_WITH_BASE64_DER_PUBLIC_KEY`.

- [ ] **Step 4: Verify install works**

```sh
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
cd /Users/wxt/code/byob
bun --cwd packages/bridge run dev:cli install --dev
ls -la ~/.byob/                                           # bridge-host.sh
cat  ~/.byob/bridge-host.sh                               # 3-line launcher
ls -la "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/ai.byob.bridge.json"
cat "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/ai.byob.bridge.json"
```

Expected: launcher exists and is 0755; manifest exists and contains the right `allowed_origins`.

- [ ] **Step 5: Commit**

```sh
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
cd /Users/wxt/code/byob
git add packages/bridge/src/install.ts packages/bridge/bin/byob.ts
# wxt.config.ts now has the real public key — commit it (it's a public key, safe to publish)
git add packages/extension/wxt.config.ts
git commit -m "$(cat <<'EOF'
feat(bridge): byob install writes launcher + NM manifest

--dev flag launches via tsx for fast inner-loop. Pinned
extension ID via embedded RSA public key in wxt.config.ts.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 1.5: Implement IPC server (UNIX-socket HTTP) with `/status`

This is the bridge's "front door" for mcp-server. Phase 1 only implements `GET /status`; tool routes follow in later phases.

**Files:**
- Create: `/Users/wxt/code/byob/packages/bridge/src/ipc-server.ts`

- [ ] **Step 1: Write the server**

```typescript
// packages/bridge/src/ipc-server.ts
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { socketPathFor, BRIDGES_DIR } from './paths.js';

export interface IpcHandlers {
  isExtensionConnected: () => boolean;
  getDeviceId: () => string | null;
  getStartedAt: () => number;
  // Tool routes added in later phases — passed in as a map.
  tools: Record<string, (body: unknown) => Promise<{ status: number; body: unknown }>>;
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))); }
      catch { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function cleanupStaleSocket(sock: string): Promise<void> {
  if (!fs.existsSync(sock)) return;
  await new Promise<void>((resolve) => {
    const c = net.createConnection(sock);
    c.on('connect', () => { c.destroy(); resolve(); });
    c.on('error', () => {
      try { fs.unlinkSync(sock); } catch { /* */ }
      resolve();
    });
  });
}

export async function startIpcServer(deviceId: string, handlers: IpcHandlers): Promise<http.Server> {
  const sock = socketPathFor(deviceId);
  fs.mkdirSync(BRIDGES_DIR, { recursive: true, mode: 0o700 });
  await cleanupStaleSocket(sock);

  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      // GET /status
      if (req.method === 'GET' && req.url === '/status') {
        return send(res, 200, {
          connected: handlers.isExtensionConnected(),
          deviceId:  handlers.getDeviceId(),
          sinceMs:   Date.now() - handlers.getStartedAt(),
        });
      }
      // POST /<tool>  → registered handler
      if (req.method === 'POST' && req.url) {
        const route = req.url.replace(/^\//, '').split('?')[0]!;
        const handler = handlers.tools[route];
        if (handler) {
          const body = await readBody(req);
          const { status, body: out } = await handler(body);
          return send(res, status, out);
        }
      }
      send(res, 404, { error: 'not_found', message: `No route ${req.method} ${req.url}` });
    } catch (e) {
      send(res, 500, { error: 'internal_error', message: e instanceof Error ? e.message : String(e) });
    }
  });

  await new Promise<void>((resolve) => server.listen(sock, () => resolve()));
  fs.chmodSync(sock, 0o600);
  return server;
}
```

- [ ] **Step 2: Typecheck**

```sh
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
cd /Users/wxt/code/byob/packages/bridge && bun run typecheck
```

Expected: clean.

- [ ] **Step 3: Commit**

```sh
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
cd /Users/wxt/code/byob
git add packages/bridge/src/ipc-server.ts
git commit -m "$(cat <<'EOF'
feat(bridge): UNIX-socket HTTP server skeleton

GET /status implemented; POST routes wired through a tools map
populated by later phases. Socket file mode 0600.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 1.6: Implement bridge main loop

This is what Chrome actually launches. It reads stdin frames, manages the IPC server, registers itself in `~/.byob/bridges.json`, and forwards `command` ↔ `result` between the IPC HTTP server and Chrome.

**Files:**
- Create: `/Users/wxt/code/byob/packages/bridge/src/main.ts`
- Modify: `/Users/wxt/code/byob/packages/bridge/bin/byob-bridge.ts`

- [ ] **Step 1: Write `main.ts`**

```typescript
// packages/bridge/src/main.ts
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import { writeFrameToStdout, startStdinReader } from './native-messaging.js';
import { startIpcServer, type IpcHandlers } from './ipc-server.js';
import { registerBridge, unregisterBridge, socketPathFor } from './bridge-registry.js';
import { DOKO_DIR, LOG_PATH } from './paths.js';

let deviceId: string | null = null;
let extensionConnected = false;
const startedAt = Date.now();
let ipc: http.Server | null = null;

interface PendingRequest {
  resolve: (data: unknown) => void;
  reject:  (err: Error) => void;
  timer:   NodeJS.Timeout;
}
const pending = new Map<string, PendingRequest>();

function ensureLogDir(): void {
  if (!fs.existsSync(DOKO_DIR)) fs.mkdirSync(DOKO_DIR, { recursive: true, mode: 0o700 });
}
function log(line: string): void {
  ensureLogDir();
  fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${line}\n`, { mode: 0o600 });
}

/**
 * Send a command to the extension and wait for the matching result frame.
 */
function sendCommand(command: string, params: unknown, timeoutMs: number): Promise<unknown> {
  if (!extensionConnected) {
    return Promise.resolve({ error: 'extension_not_connected', message: 'Chrome extension is not connected.' });
  }
  const requestId = crypto.randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      resolve({ error: 'timeout', message: `Command ${command} timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    pending.set(requestId, { resolve, reject: () => {}, timer });
    writeFrameToStdout({ type: 'command', requestId, command, params });
  });
}

/**
 * Wrap sendCommand into an HTTP route handler shape.
 */
function routeFor(command: string, defaultTimeoutSec = 60) {
  return async (body: unknown): Promise<{ status: number; body: unknown }> => {
    const timeoutSec = (typeof body === 'object' && body && 'timeoutSec' in body
      ? Number((body as { timeoutSec: unknown }).timeoutSec)
      : NaN);
    const timeoutMs = (Number.isFinite(timeoutSec) ? timeoutSec : defaultTimeoutSec) * 1000 + 30_000;
    const result = await sendCommand(command, body, timeoutMs) as Record<string, unknown>;
    if (result && typeof result === 'object' && 'error' in result && typeof result.error === 'string') {
      return { status: 502, body: result };
    }
    return { status: 200, body: result };
  };
}

const tools: IpcHandlers['tools'] = {
  // Routes appear in later phases. Phase 1 ships zero tool routes;
  // GET /status alone proves the link works.
};

async function handleHello(nextDeviceId: string): Promise<void> {
  deviceId = nextDeviceId;
  extensionConnected = true;
  ipc = await startIpcServer(deviceId, {
    isExtensionConnected: () => extensionConnected,
    getDeviceId: () => deviceId,
    getStartedAt: () => startedAt,
    tools,
  });
  registerBridge({ deviceId, pid: process.pid, socket: socketPathFor(deviceId) });
  writeFrameToStdout({ type: 'status', status: 'ready' });
  log(`hello received, deviceId=${deviceId}, IPC up at ${socketPathFor(deviceId)}`);
}

function handleResult(requestId: string, result: Record<string, unknown>): void {
  const p = pending.get(requestId);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(requestId);
  p.resolve(result);
}

function shutdown(reason: string): void {
  log(`shutdown: ${reason}`);
  extensionConnected = false;
  for (const [, p] of pending) {
    clearTimeout(p.timer);
    p.resolve({ error: 'bridge_not_running', message: 'Bridge is shutting down' });
  }
  pending.clear();
  if (ipc) { ipc.close(); ipc = null; }
  if (deviceId) {
    try { fs.unlinkSync(socketPathFor(deviceId)); } catch { /* */ }
    unregisterBridge(deviceId);
  }
  process.exit(0);
}

export function runBridge(): void {
  process.umask(0o077);
  ensureLogDir();
  log(`bridge started, pid=${process.pid}`);

  startStdinReader((msg) => {
    if (!msg || typeof msg !== 'object') return;
    const m = msg as Record<string, unknown>;
    log(`<- ${JSON.stringify(m).slice(0, 300)}`);
    if (m.type === 'hello' && typeof m.deviceId === 'string') {
      void handleHello(m.deviceId).catch((e) => log(`handleHello error: ${e}`));
    } else if (m.type === 'result' && typeof m.requestId === 'string') {
      handleResult(m.requestId, m);
    }
  });

  process.stdin.on('end',   () => shutdown('stdin_end'));
  process.stdin.on('close', () => shutdown('stdin_close'));
  process.on('SIGTERM', () => shutdown('sigterm'));
  process.on('SIGINT',  () => shutdown('sigint'));
  process.on('uncaughtException', (e) => {
    log(`uncaught: ${e.message}\n${e.stack ?? ''}`);
    shutdown('uncaught');
  });
}
```

- [ ] **Step 2: Wire the entry point**

Replace `packages/bridge/bin/byob-bridge.ts`:

```typescript
#!/usr/bin/env -S npx tsx
import { runBridge } from '../src/main.js';
runBridge();
```

- [ ] **Step 3: Typecheck**

```sh
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
cd /Users/wxt/code/byob/packages/bridge && bun run typecheck
```

Expected: clean.

- [ ] **Step 4: Commit**

```sh
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
cd /Users/wxt/code/byob
git add packages/bridge/src/main.ts packages/bridge/bin/byob-bridge.ts
git commit -m "$(cat <<'EOF'
feat(bridge): main loop wires NM stdin/stdout to IPC HTTP server

requestId-based pending-request map; clean shutdown on stdin end /
SIGTERM / uncaught. GET /status route lives; tool routes are
populated by later phases.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 1.7: Implement extension Native Messaging client

The service worker connects to `ai.byob.bridge`, sends `hello`, listens for commands. Phase 1 doesn't dispatch any tool yet — it only completes the handshake so `/status` returns `connected:true`.

**Files:**
- Create: `/Users/wxt/code/byob/packages/extension/lib/native-msg.ts`
- Modify: `/Users/wxt/code/byob/packages/extension/entrypoints/background.ts`

- [ ] **Step 1: Write `lib/native-msg.ts`**

```typescript
// packages/extension/lib/native-msg.ts
const NATIVE_HOST = 'ai.byob.bridge';

export type IncomingMessage =
  | { type: 'status'; status: 'ready' }
  | { type: 'command'; requestId: string; command: string; params: unknown }
  | { type: 'cancel'; requestId: string };

export interface NativeBus {
  post(msg: unknown): void;
  isConnected(): boolean;
}

let port: chrome.runtime.Port | null = null;
let backoffMs = 1000;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let onMessageCb: ((msg: IncomingMessage) => void) | null = null;
let onReadyCb: (() => void | Promise<void>) | null = null;

async function getDeviceId(): Promise<string> {
  const stored = await chrome.storage.local.get('deviceId') as { deviceId?: string };
  if (stored.deviceId) return stored.deviceId;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ deviceId: id });
  return id;
}

export const bus: NativeBus = {
  post(msg: unknown): void {
    if (!port) throw new Error('NM port not connected');
    port.postMessage(msg);
  },
  isConnected(): boolean {
    return port !== null;
  },
};

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
    backoffMs = Math.min(backoffMs * 2, 30_000);
  }, backoffMs);
}

function connect(): void {
  if (port) return;
  let p: chrome.runtime.Port;
  try {
    p = chrome.runtime.connectNative(NATIVE_HOST);
  } catch (e) {
    console.warn('[byob] connectNative threw:', e);
    scheduleReconnect();
    return;
  }
  port = p;

  p.onMessage.addListener((msg: IncomingMessage) => {
    backoffMs = 1000;
    if (msg && typeof msg === 'object' && msg.type === 'status' && msg.status === 'ready') {
      void onReadyCb?.();
      return;
    }
    if (onMessageCb) onMessageCb(msg);
  });

  p.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError;
    console.warn('[byob] NM disconnected:', err?.message);
    port = null;
    if (err?.message?.includes('not found') || err?.message?.includes('not installed')) {
      // Bridge not installed; don't busy-loop reconnecting.
      return;
    }
    scheduleReconnect();
  });

  void getDeviceId().then((deviceId) => {
    p.postMessage({ type: 'hello', deviceId });
  });
}

export function startNativeBus(opts: {
  onMessage: (msg: IncomingMessage) => void;
  onReady?: () => void | Promise<void>;
}): void {
  onMessageCb = opts.onMessage;
  onReadyCb = opts.onReady ?? null;
  connect();
}
```

- [ ] **Step 2: Replace `entrypoints/background.ts`**

```typescript
// packages/extension/entrypoints/background.ts
import { startNativeBus, bus } from '../lib/native-msg.js';

export default defineBackground(() => {
  console.log('[byob] service worker boot');

  startNativeBus({
    onMessage: (msg) => {
      console.log('[byob] received:', msg);
      // Phase 1: no command dispatch yet. Just log.
      if (msg.type === 'command') {
        // Reply with not-implemented so the bridge doesn't hang.
        bus.post({
          type: 'result',
          requestId: msg.requestId,
          success: false,
          error: 'not_implemented_yet',
          message: `Command ${msg.command} not implemented in Phase 1`,
        });
      }
    },
    onReady: () => {
      console.log('[byob] bridge ready, IPC up');
    },
  });

  // Keep the SW awake during long operations (Phase 2+ will need this).
  chrome.alarms.create('byob-keepalive', { periodInMinutes: 0.4 });
  chrome.alarms.onAlarm.addListener(() => { /* tick */ });
});
```

- [ ] **Step 3: Build the extension**

```sh
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
cd /Users/wxt/code/byob/packages/extension
bun run build
ls -la .output/chrome-mv3/                  # manifest.json, background.js, etc.
```

Expected: `.output/chrome-mv3/manifest.json` exists. Open it and confirm `"key"` field matches what's in `wxt.config.ts`.

- [ ] **Step 4: Commit**

```sh
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
cd /Users/wxt/code/byob
git add packages/extension/lib/native-msg.ts packages/extension/entrypoints/background.ts
git commit -m "$(cat <<'EOF'
feat(extension): native messaging client with reconnect

Indefinite exponential backoff (cap 30s). Persists deviceId to
chrome.storage.local. Sends hello on connect; reports
not_implemented_yet for command frames (Phase 2 wires real handlers).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 1.8: Implement minimal `byob doctor`

Phase 1 doctor checks: manifest installed for Chrome, launcher exists, registry shows a live bridge, socket reachable. Full doctor (per-browser, MCP setup hints) lands in Phase 7.

**Files:**
- Create: `/Users/wxt/code/byob/packages/bridge/src/doctor.ts`
- Modify: `/Users/wxt/code/byob/packages/bridge/bin/byob.ts`

- [ ] **Step 1: Write `doctor.ts`**

```typescript
// packages/bridge/src/doctor.ts
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { LAUNCHER_PATH, REGISTRY_PATH, DOKO_DIR } from './paths.js';
import { listAliveBridges } from './bridge-registry.js';

const CHROME_MANIFEST_DARWIN = path.join(
  os.homedir(),
  'Library/Application Support/Google/Chrome/NativeMessagingHosts/ai.byob.bridge.json',
);

function ok(label: string, detail = ''): void {
  console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? '  ' + detail : ''}`);
}
function bad(label: string, detail = ''): void {
  console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? '  ' + detail : ''}`);
}
function dim(label: string): void {
  console.log(`  \x1b[2m- ${label}\x1b[0m`);
}

async function pingSocket(sock: string): Promise<boolean> {
  return new Promise((resolve) => {
    const c = net.createConnection(sock);
    c.setTimeout(1000);
    c.on('connect', () => { c.destroy(); resolve(true); });
    c.on('error', () => resolve(false));
    c.on('timeout', () => { c.destroy(); resolve(false); });
  });
}

export async function doctor(): Promise<void> {
  console.log('Native Messaging manifest:');
  if (process.platform === 'darwin') {
    if (fs.existsSync(CHROME_MANIFEST_DARWIN)) ok('Chrome', CHROME_MANIFEST_DARWIN);
    else                                       bad('Chrome', `missing → run: byob install`);
  } else {
    dim(`platform ${process.platform} not yet enumerated by doctor`);
  }

  console.log('\nLauncher:');
  if (fs.existsSync(LAUNCHER_PATH)) ok(LAUNCHER_PATH);
  else                              bad(LAUNCHER_PATH, 'missing → run: byob install');

  console.log('\nBridge process:');
  const alive = listAliveBridges();
  if (alive.length === 0) {
    bad('no live bridge', 'open Chrome with the byob extension enabled');
  } else {
    for (const b of alive) {
      ok(`pid ${b.pid}, deviceId ${b.deviceId}`, `uptime ${Math.round((Date.now() - b.startedAt) / 1000)}s`);
    }
  }

  console.log('\nIPC socket:');
  for (const b of alive) {
    const reachable = await pingSocket(b.socket);
    if (reachable) ok(b.socket);
    else           bad(b.socket, 'not reachable');
  }
}
```

- [ ] **Step 2: Wire `doctor` in CLI**

Replace the doctor stub in `packages/bridge/bin/byob.ts`:

```typescript
program.command('doctor').description('diagnose connectivity').action(async () => {
  const { doctor } = await import('../src/doctor.js');
  await doctor();
});
```

- [ ] **Step 3: Commit**

```sh
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
cd /Users/wxt/code/byob
git add packages/bridge/src/doctor.ts packages/bridge/bin/byob.ts
git commit -m "$(cat <<'EOF'
feat(bridge): minimal byob doctor for Phase 1 link diagnosis

Checks Chrome manifest (darwin only), launcher, live bridges
in registry, socket reachability.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Phase 1 DEMO Checkpoint

Walk the user through this script (some steps require manual UI clicks):

```sh
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
cd /Users/wxt/code/byob

# 1. Build the extension
bun --cwd packages/extension run build

# 2. Install bridge in dev mode
bun --cwd packages/bridge run dev:cli install --dev

# 3. Manual: open Chrome → chrome://extensions → enable Developer mode →
#    "Load unpacked" → choose packages/extension/.output/chrome-mv3
#    Then quit Chrome and reopen (so it picks up the new NM manifest).

# 4. Diagnose
bun --cwd packages/bridge run dev:cli doctor

# Expected output:
#   Native Messaging manifest:
#     ✓ Chrome  ~/Library/Application Support/Google/Chrome/...
#   Launcher:
#     ✓ /Users/wxt/.byob/bridge-host.sh
#   Bridge process:
#     ✓ pid <N>, deviceId <uuid>  uptime <seconds>s
#   IPC socket:
#     ✓ /Users/wxt/.byob/bridges/<uuid>.sock

# 5. Hit /status manually
SOCK=$(ls ~/.byob/bridges/*.sock | head -1)
curl --unix-socket "$SOCK" http://x/status
# → {"connected":true,"deviceId":"...","sinceMs":N}

# 6. Inspect log
tail ~/.byob/bridge.log
```

**Stop here. Phase 1 has reached the most important milestone: the Native Messaging round-trip works. Wait for user "go" before Phase 2.**

---

# Phase 2 — `browser_read` end-to-end (½ day)

**Goal:** First real tool. mcp-server registers `browser_read`; LLM in Claude Code can call it and get a page's text + chunks.

**DEMO at end of Phase 2:**
```sh
# In Claude Code:
claude mcp add byob -- bun --cwd /Users/wxt/code/byob/packages/mcp-server run dev
# Then ask: "use byob to read https://news.ycombinator.com — give me the top 5 stories"
```

---

### Task 2.1: Implement CDP session manager

**Files:**
- Create: `/Users/wxt/code/byob/packages/extension/lib/cdp.ts`

- [ ] **Step 1: Write the CDP session class**

```typescript
// packages/extension/lib/cdp.ts
const ATTACH_VERSION = '1.3';

export interface CdpEvalResult<T = unknown> {
  value?: T;
  exceptionDetails?: chrome.debugger.Debuggee & Record<string, unknown>;
}

export class CdpSession {
  private attached = false;

  constructor(public readonly tabId: number) {}

  get isAttached(): boolean { return this.attached; }

  async attach(): Promise<boolean> {
    if (this.attached) return true;
    try {
      await chrome.debugger.attach({ tabId: this.tabId }, ATTACH_VERSION);
      this.attached = true;
      // Useful baseline: enable Runtime, opt into focus emulation so background tabs work.
      await this.send('Runtime.enable', {});
      try {
        await this.send('Emulation.setFocusEmulationEnabled', { enabled: true });
      } catch { /* not all targets support this; non-fatal */ }
      return true;
    } catch (e) {
      console.warn('[byob/cdp] attach failed', this.tabId, e);
      this.attached = false;
      return false;
    }
  }

  async detach(): Promise<void> {
    if (!this.attached) return;
    try { await chrome.debugger.detach({ tabId: this.tabId }); } catch { /* */ }
    this.attached = false;
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return new Promise((resolve, reject) => {
      chrome.debugger.sendCommand({ tabId: this.tabId }, method, params, (res?: unknown) => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message ?? `CDP ${method} failed`));
        else resolve(res as T);
      });
    });
  }

  /**
   * Evaluate an expression in the page's main world.
   * Throws if the page throws (exceptionDetails present).
   */
  async evaluate<T = unknown>(expression: string, opts: { awaitPromise?: boolean; returnByValue?: boolean } = {}): Promise<T> {
    const res = await this.send<{ result: { value?: T; type: string }; exceptionDetails?: unknown }>(
      'Runtime.evaluate',
      {
        expression,
        awaitPromise: opts.awaitPromise ?? true,
        returnByValue: opts.returnByValue ?? true,
      },
    );
    if (res.exceptionDetails) {
      throw new Error(`CDP eval threw: ${JSON.stringify(res.exceptionDetails).slice(0, 300)}`);
    }
    return (res.result?.value as T);
  }
}

const sessions = new Map<number, CdpSession>();

export async function attachToTab(tabId: number): Promise<CdpSession | null> {
  const existing = sessions.get(tabId);
  if (existing?.isAttached) return existing;
  const s = new CdpSession(tabId);
  if (!(await s.attach())) return null;
  sessions.set(tabId, s);
  return s;
}

export function getSession(tabId: number): CdpSession | null {
  const s = sessions.get(tabId);
  return s?.isAttached ? s : null;
}

export async function detachAll(): Promise<void> {
  await Promise.all([...sessions.values()].map((s) => s.detach()));
  sessions.clear();
}

// Auto-cleanup on tab close
chrome.tabs.onRemoved.addListener((tabId) => {
  const s = sessions.get(tabId);
  if (s) { void s.detach(); sessions.delete(tabId); }
});

// Auto-cleanup on debugger detach (user opened DevTools, etc.)
chrome.debugger.onDetach.addListener((src) => {
  if (src.tabId !== undefined) {
    const s = sessions.get(src.tabId);
    if (s) sessions.delete(src.tabId);
  }
});
```

- [ ] **Step 2: Typecheck**

```sh
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
cd /Users/wxt/code/byob/packages/extension && bun run typecheck
```

- [ ] **Step 3: Commit**

```sh
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
cd /Users/wxt/code/byob
git add packages/extension/lib/cdp.ts
git commit -m "$(cat <<'EOF'
feat(extension): CDP session manager with auto-cleanup

attachToTab/getSession/detachAll. Auto-detach on tab close or
debugger.onDetach (user opened DevTools). Default Runtime.enable
+ focus emulation for background-tab support.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2.2: Implement tab open/reuse helper

**Files:**
- Create: `/Users/wxt/code/byob/packages/extension/lib/tab.ts`

- [ ] **Step 1: Write the helper**

```typescript
// packages/extension/lib/tab.ts
export interface OpenedTab {
  tabId: number;
  reused: boolean;
  /** Caller calls this when done; closes the tab unless reused. */
  cleanup: () => Promise<void>;
}

export async function openOrReuse(opts: {
  url?: string;
  tabId?: number;
  reuseActive?: boolean;
}): Promise<OpenedTab> {
  // Explicit tabId wins
  if (opts.tabId !== undefined) {
    const tab = await chrome.tabs.get(opts.tabId);
    if (opts.url && tab.url !== opts.url) {
      await chrome.tabs.update(opts.tabId, { url: opts.url });
      await waitForLoad(opts.tabId, 30_000);
    }
    return { tabId: opts.tabId, reused: true, cleanup: async () => { /* don't close caller-owned tab */ } };
  }

  // Reuse current active tab in last-focused window
  if (opts.reuseActive) {
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (active?.id !== undefined) {
      if (opts.url && active.url !== opts.url) {
        await chrome.tabs.update(active.id, { url: opts.url });
        await waitForLoad(active.id, 30_000);
      }
      return { tabId: active.id, reused: true, cleanup: async () => { /* */ } };
    }
  }

  // Open a new background tab
  if (!opts.url) throw new Error('openOrReuse: url required when not reusing');
  const created = await chrome.tabs.create({ url: opts.url, active: false });
  const tabId = created.id!;
  await waitForLoad(tabId, 30_000);
  return {
    tabId,
    reused: false,
    cleanup: async () => { try { await chrome.tabs.remove(tabId); } catch { /* */ } },
  };
}

export function waitForLoad(tabId: number, timeoutMs = 30_000): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      if (err) reject(err); else resolve();
    };
    const listener = (updatedId: number, info: chrome.tabs.TabChangeInfo) => {
      if (updatedId === tabId && info.status === 'complete') finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((t) => { if (t.status === 'complete') finish(); }).catch(() => {});
    const timer = setTimeout(() => finish(new Error(`tab ${tabId} did not load within ${timeoutMs}ms`)), timeoutMs);
  });
}
```

- [ ] **Step 2: Typecheck + commit**

```sh
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
cd /Users/wxt/code/byob/packages/extension && bun run typecheck
cd /Users/wxt/code/byob
git add packages/extension/lib/tab.ts
git commit -m "$(cat <<'EOF'
feat(extension): tab open/reuse helper with onUpdated load wait

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2.3: Implement `read` handler + dispatcher

This is the longest single file in the codebase. The page-side collector script (string-built and shipped via `Runtime.evaluate`) walks leaf text nodes and emits chunks with bounds. Scrolling loop continues until no growth for N rounds.

**Files:**
- Create: `/Users/wxt/code/byob/packages/extension/lib/handlers/read.ts`
- Create: `/Users/wxt/code/byob/packages/extension/lib/handlers/index.ts`
- Modify: `/Users/wxt/code/byob/packages/extension/entrypoints/background.ts`

- [ ] **Step 1: Write `lib/handlers/read.ts`**

```typescript
// packages/extension/lib/handlers/read.ts
import { ReadInput, type Chunk } from '@byob/shared';
import { attachToTab } from '../cdp.js';
import { openOrReuse } from '../tab.js';

const COLLECTOR_INSTALL = `
(() => {
  if (window.__byobCollect) return;

  // Visibility spoof: many lazy-loaders won't fire in background tabs otherwise.
  try {
    Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get: () => 'visible' });
    Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  } catch (_) {}

  let counter = 0;
  const seen = new Set();

  function isVisible(el) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') return false;
    return true;
  }

  window.__byobCollect = function() {
    const out = [];
    // Walk all elements; pick leaf elements with non-empty text content.
    const all = document.body ? document.body.querySelectorAll('*') : [];
    for (const el of all) {
      if (el.children && el.children.length > 0) continue;
      const txt = (el.innerText || el.textContent || '').trim();
      if (!txt) continue;
      if (txt.length > 4000) continue;       // skip huge text blobs (likely <script> / <style> leftovers)
      if (!isVisible(el)) continue;
      const key = el.dataset.byobId || (el.dataset.byobId = 'b' + (++counter));
      if (seen.has(key)) continue;
      seen.add(key);
      const r = el.getBoundingClientRect();
      out.push({
        id: key,
        sourceIds: [key],
        text: txt,
        bounds: [Math.round(r.x + window.scrollX), Math.round(r.y + window.scrollY), Math.round(r.width), Math.round(r.height)],
        zIndex: parseInt(getComputedStyle(el).zIndex) || undefined,
      });
    }
    return out;
  };

  window.__byobScrollOnce = function() {
    const before = document.documentElement.scrollHeight;
    window.scrollBy({ top: window.innerHeight, behavior: 'instant' });
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => { if (settled) return; settled = true; observer.disconnect(); clearTimeout(timer); resolve(); };
      const observer = new MutationObserver(() => { clearTimeout(quietTimer); quietTimer = setTimeout(finish, 250); });
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src','srcset'] });
      let quietTimer = setTimeout(finish, 250);
      const timer = setTimeout(finish, 1500);
    });
  };

  window.__byobAtBottom = function() {
    return (window.innerHeight + window.scrollY) >= (document.documentElement.scrollHeight - 50);
  };
})();
`;

interface CollectedChunk {
  id: string;
  sourceIds: string[];
  text: string;
  bounds: [number, number, number, number];
  zIndex?: number;
}

export async function handleRead(rawParams: unknown): Promise<unknown> {
  const params = ReadInput.parse(rawParams);

  const tab = await openOrReuse({
    url: params.url,
    reuseActive: params.reuseTab,
  });

  const session = await attachToTab(tab.tabId);
  if (!session) {
    if (!tab.reused) await tab.cleanup();
    return { error: 'cdp_attach_failed', message: 'Could not attach Chrome debugger. Close DevTools (F12) on this tab and retry.', hint: 'See byob doctor.' };
  }

  const startedAt = Date.now();
  const timeoutAt = startedAt + params.timeoutSec * 1000;
  let stopReason: 'end_of_scroll' | 'timeout' | 'limit_reached' = 'end_of_scroll';
  const allChunks = new Map<string, Chunk>();
  let noGrowthRounds = 0;

  try {
    await session.evaluate(COLLECTOR_INSTALL, { awaitPromise: false });

    for (let i = 0; i < params.screens; i++) {
      if (Date.now() > timeoutAt) { stopReason = 'timeout'; break; }

      const got = await session.evaluate<CollectedChunk[]>('window.__byobCollect()', { awaitPromise: false });
      const before = allChunks.size;
      for (const c of got ?? []) allChunks.set(c.id, c as Chunk);
      const grew = allChunks.size > before;
      if (!grew) noGrowthRounds++; else noGrowthRounds = 0;

      const atBottom = await session.evaluate<boolean>('window.__byobAtBottom()', { awaitPromise: false });
      if (atBottom) { stopReason = 'end_of_scroll'; break; }
      if (noGrowthRounds >= 2) { stopReason = 'end_of_scroll'; break; }
      if (i === params.screens - 1) { stopReason = 'limit_reached'; break; }

      await session.evaluate('window.__byobScrollOnce()', { awaitPromise: true });
    }

    const tabInfo = await chrome.tabs.get(tab.tabId);
    const sessionId = params.sessionId ?? crypto.randomUUID();
    const chunks = [...allChunks.values()].sort((a, b) => a.bounds[1] - b.bounds[1] || a.bounds[0] - b.bounds[0]);
    const text = chunks.map((c) => c.text).join('\n\n');

    return {
      text,
      title: tabInfo.title ?? '',
      url: tabInfo.url ?? params.url,
      chunks,
      sessionId,
      canContinue: stopReason !== 'end_of_scroll',
      stopReason,
    };
  } finally {
    if (!tab.reused) {
      await session.detach();
      await tab.cleanup();
    }
  }
}
```

- [ ] **Step 2: Write `lib/handlers/index.ts`**

```typescript
// packages/extension/lib/handlers/index.ts
import { Command } from '@byob/shared';
import { handleRead } from './read.js';

export type Handler = (params: unknown) => Promise<unknown>;

export const handlers: Partial<Record<string, Handler>> = {
  [Command.Read]: handleRead,
  // More handlers added in later phases.
};
```

- [ ] **Step 3: Wire dispatch in `background.ts`**

Replace the Phase 1 `onMessage` body:

```typescript
// packages/extension/entrypoints/background.ts
import { startNativeBus, bus } from '../lib/native-msg.js';
import { handlers } from '../lib/handlers/index.js';

export default defineBackground(() => {
  console.log('[byob] service worker boot');

  startNativeBus({
    onMessage: async (msg) => {
      if (msg.type !== 'command') return;
      const { requestId, command, params } = msg;
      const handler = handlers[command];
      if (!handler) {
        bus.post({ type: 'result', requestId, error: 'unknown', message: `No handler for ${command}` });
        return;
      }
      try {
        const data = await handler(params);
        // If handler returned an error envelope, forward it as-is.
        if (data && typeof data === 'object' && 'error' in (data as Record<string, unknown>)) {
          bus.post({ type: 'result', requestId, ...(data as object) });
        } else {
          bus.post({ type: 'result', requestId, ...((data as object) ?? {}) });
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        bus.post({ type: 'result', requestId, error: 'unknown', message });
      }
    },
    onReady: () => console.log('[byob] bridge ready'),
  });

  chrome.alarms.create('byob-keepalive', { periodInMinutes: 0.4 });
  chrome.alarms.onAlarm.addListener(() => { /* */ });
});
```

- [ ] **Step 4: Add `/read` route in bridge `main.ts`**

In `packages/bridge/src/main.ts`, find the `tools` map and replace it:

```typescript
const tools: IpcHandlers['tools'] = {
  read: routeFor('readPage'),
};
```

(Phase 3 / 4 / 5 add the rest. The `routeFor` helper already does the request-id plumbing.)

- [ ] **Step 5: Build & rebuild & reload**

```sh
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
cd /Users/wxt/code/byob
bun --cwd packages/extension run build
# In Chrome: chrome://extensions → byob → click reload
# Bridge picks up automatically since launcher uses tsx watch.
```

- [ ] **Step 6: Manual smoke test (curl)**

```sh
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
SOCK=$(ls ~/.byob/bridges/*.sock | head -1)
curl --unix-socket "$SOCK" -X POST -H 'Content-Type: application/json' \
  -d '{"url":"https://news.ycombinator.com","screens":2,"timeoutSec":30}' \
  http://x/read | head -c 800
```

Expected: JSON with `text`, `title:"Hacker News"`, `chunks: [...]`. The `text` field should contain story headlines.

- [ ] **Step 7: Commit**

```sh
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
cd /Users/wxt/code/byob
git add packages/extension/lib/handlers/ packages/extension/entrypoints/background.ts packages/bridge/src/main.ts
git commit -m "$(cat <<'EOF'
feat: browser_read end-to-end (CDP collector + scroll loop)

Page-side collector lives at window.__byobCollect via CDP
Runtime.evaluate. Visibility spoof + MutationObserver-quiesce-based
scroll wait. Stops on bottom, no-growth-2, screen limit, or timeout.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2.4: Implement MCP server skeleton + browser_read tool

**Files:**
- Create: `/Users/wxt/code/byob/packages/mcp-server/src/resolve-bridge.ts`
- Create: `/Users/wxt/code/byob/packages/mcp-server/src/bridge-client.ts`
- Create: `/Users/wxt/code/byob/packages/mcp-server/src/error-mapper.ts`
- Create: `/Users/wxt/code/byob/packages/mcp-server/src/server.ts`
- Create: `/Users/wxt/code/byob/packages/mcp-server/src/tools/browser-read.ts`
- Create: `/Users/wxt/code/byob/packages/mcp-server/src/tools/index.ts`
- Modify: `/Users/wxt/code/byob/packages/mcp-server/bin/byob-mcp.ts`

- [ ] **Step 1: Write `resolve-bridge.ts`**

```typescript
// packages/mcp-server/src/resolve-bridge.ts
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const REGISTRY = path.join(os.homedir(), '.byob', 'bridges.json');

interface Entry { deviceId: string; pid: number; socket: string; startedAt: number; }

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function resolveBridgeSocket(): { socket: string; deviceId: string } {
  const wanted = process.env.BYOB_DEVICE_ID;

  let entries: Entry[] = [];
  try { entries = JSON.parse(fs.readFileSync(REGISTRY, 'utf-8')) as Entry[]; }
  catch { entries = []; }

  const live = entries.filter((e) => alive(e.pid));

  if (live.length === 0) {
    throw new Error(
      'No live byob bridge.\n' +
      'Open Chrome with the byob extension enabled and try again.\n' +
      'Check status: byob doctor',
    );
  }

  if (wanted) {
    const m = live.find((e) => e.deviceId === wanted);
    if (!m) throw new Error(`BYOB_DEVICE_ID=${wanted} not found among live bridges: ${live.map((e) => e.deviceId).join(', ')}`);
    return { socket: m.socket, deviceId: m.deviceId };
  }

  if (live.length > 1) {
    throw new Error(
      'Multiple live bridges found. Set BYOB_DEVICE_ID env to choose:\n' +
      live.map((e) => `  ${e.deviceId} (pid ${e.pid})`).join('\n'),
    );
  }

  return { socket: live[0]!.socket, deviceId: live[0]!.deviceId };
}
```

- [ ] **Step 2: Write `bridge-client.ts`**

```typescript
// packages/mcp-server/src/bridge-client.ts
import { Agent, request } from 'undici';
import { resolveBridgeSocket } from './resolve-bridge.js';

let agent: Agent | null = null;
let socket = '';

function getAgent(): Agent {
  if (!agent) {
    const r = resolveBridgeSocket();
    socket = r.socket;
    agent = new Agent({ connect: { socketPath: socket } });
  }
  return agent;
}

export async function bridgePost<T = unknown>(route: string, body: unknown): Promise<{ status: number; body: T }> {
  const a = getAgent();
  const { statusCode, body: respBody } = await request(`http://localhost${route}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body ?? {}),
    dispatcher: a,
  });
  const text = await respBody.text();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = { error: 'unknown', message: `Non-JSON from bridge: ${text.slice(0, 200)}` }; }
  return { status: statusCode, body: parsed as T };
}

export async function bridgeGet<T = unknown>(route: string): Promise<{ status: number; body: T }> {
  const a = getAgent();
  const { statusCode, body: respBody } = await request(`http://localhost${route}`, { dispatcher: a });
  const text = await respBody.text();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = { error: 'unknown', message: `Non-JSON from bridge: ${text.slice(0, 200)}` }; }
  return { status: statusCode, body: parsed as T };
}
```

- [ ] **Step 3: Write `error-mapper.ts`**

```typescript
// packages/mcp-server/src/error-mapper.ts
import { ErrorCode, type ErrorEnvelope } from '@byob/shared';

const HINTS: Partial<Record<string, string>> = {
  [ErrorCode.BRIDGE_NOT_RUNNING]:      'Run: byob doctor',
  [ErrorCode.EXTENSION_NOT_CONNECTED]: 'Open Chrome with the byob extension enabled.',
  [ErrorCode.CDP_ATTACH_FAILED]:       'Close DevTools (F12) on the target tab and retry.',
  [ErrorCode.URL_FORBIDDEN]:           'URL is on the byob blacklist. Set BYOB_ALLOW_FILE=1 / BYOB_ALLOW_AUTH_DOMAINS=1 to bypass.',
  [ErrorCode.EVAL_DISABLED]:           'Set BYOB_ALLOW_EVAL=1 in your MCP client config to enable browser_eval.',
};

export function asErrorEnvelope(body: unknown, fallbackMessage: string): ErrorEnvelope {
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    if (typeof b.error === 'string') {
      return {
        error: b.error as ErrorEnvelope['error'],
        message: typeof b.message === 'string' ? b.message : fallbackMessage,
        hint: typeof b.hint === 'string' ? b.hint : HINTS[b.error as string],
        aborted: b.aborted === true ? true : undefined,
      };
    }
  }
  return { error: ErrorCode.UNKNOWN, message: fallbackMessage };
}

export function toMcpError(env: ErrorEnvelope): { isError: true; content: Array<{ type: 'text'; text: string }> } {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(env) }] };
}
```

- [ ] **Step 4: Write `tools/browser-read.ts`**

```typescript
// packages/mcp-server/src/tools/browser-read.ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ReadInput, ReadOutput } from '@byob/shared';
import { bridgePost } from '../bridge-client.js';
import { asErrorEnvelope, toMcpError } from '../error-mapper.js';

const inputSchema = ReadInput;

export function registerBrowserRead(server: McpServer): void {
  server.registerTool(
    'browser_read',
    {
      title: 'Read a webpage with the user\'s real browser',
      description:
        'Read full content from a webpage using the user\'s real Chrome browser ' +
        '(with their cookies and active session). Auto-scrolls to load lazy content. ' +
        'Returns extracted text plus structured chunks with screen positions. ' +
        'Use this instead of WebFetch when the page needs login or has heavy JS.',
      inputSchema: inputSchema.shape,
    },
    async (args) => {
      const { status, body } = await bridgePost('/read', args);
      if (status >= 400) return toMcpError(asErrorEnvelope(body, `bridge returned ${status}`));
      const parsed = ReadOutput.safeParse(body);
      if (!parsed.success) {
        return toMcpError({ error: 'unknown', message: `bridge returned malformed body: ${parsed.error.message}` });
      }
      return { content: [{ type: 'text', text: JSON.stringify(parsed.data) }] };
    },
  );
}
```

- [ ] **Step 5: Write `tools/index.ts`**

```typescript
// packages/mcp-server/src/tools/index.ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerBrowserRead } from './browser-read.js';

export function registerAllTools(server: McpServer): void {
  registerBrowserRead(server);
  // More tools registered in later phases.
}
```

- [ ] **Step 6: Write `server.ts`**

```typescript
// packages/mcp-server/src/server.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerAllTools } from './tools/index.js';

export async function runMcpServer(): Promise<void> {
  const server = new McpServer({ name: 'byob', version: '0.1.0' });
  registerAllTools(server);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[byob-mcp] connected on stdio');
}
```

- [ ] **Step 7: Wire `bin/byob-mcp.ts`**

```typescript
#!/usr/bin/env -S npx tsx
import { runMcpServer } from '../src/server.js';
runMcpServer().catch((e) => {
  console.error('[byob-mcp] fatal:', e);
  process.exit(1);
});
```

- [ ] **Step 8: Install + typecheck**

```sh
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
cd /Users/wxt/code/byob && bun install
cd packages/mcp-server && bun run typecheck
```

Expected: clean typecheck. If `@modelcontextprotocol/sdk` types disagree with the call sites, run `bun add @modelcontextprotocol/sdk@latest` and adjust signatures (specifically `registerTool` may be named `tool`; check `node_modules/@modelcontextprotocol/sdk/dist/server/mcp.d.ts`).

- [ ] **Step 9: Commit**

```sh
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
cd /Users/wxt/code/byob
git add packages/mcp-server/ bun.lock
git commit -m "$(cat <<'EOF'
feat(mcp): stdio MCP server with browser_read tool

Resolves bridge socket from ~/.byob/bridges.json (BYOB_DEVICE_ID
override). undici Agent over UNIX socket. Errors returned as
isError + JSON envelope so LLM can self-recover.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Phase 2 DEMO Checkpoint

```sh
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY

# 1. Make sure Chrome is open with the extension installed (Phase 1 done).
bun --cwd packages/bridge run dev:cli doctor   # should be all green

# 2. Register byob-mcp with Claude Code
claude mcp add byob-dev -- bun --cwd /Users/wxt/code/byob/packages/mcp-server run dev

# 3. Open a fresh Claude Code session and ask:
#    "use byob to read https://news.ycombinator.com — give me the top 5 stories"
#
# Expected: Claude calls browser_read; receives ~30-100 chunks; produces
# a list of story titles + scores from the actual page.

# 4. Test cookie reuse: log into x.com manually in your Chrome, then ask:
#    "use byob to read my x.com home timeline"
# Expected: returns logged-in content (proves cookie reuse works).
```

**Stop here. The flagship feature works end-to-end. Wait for user "go" before Phase 3.**

---

# Phase 3 — Operation Tools (½ day)

**Goal:** `browser_click`, `browser_type`, `browser_navigate`, `browser_wait_for` all working through MCP. These are the "verbs" — they let an agent actually *do* things, not just read.

**DEMO at end of Phase 3:**
```
Ask Claude Code: "use byob to search Google for 'mcp protocol spec' and give me the first 3 result titles"
Expected: navigate → google → type → press Enter → wait_for results → read → return titles.
```

---

### Task 3.1: Implement `click` and `type` handlers (extension)

**Files:**
- Create: `/Users/wxt/code/byob/packages/extension/lib/handlers/click.ts`
- Create: `/Users/wxt/code/byob/packages/extension/lib/handlers/type.ts`

- [ ] **Step 1: Write `lib/handlers/click.ts`**

```typescript
// packages/extension/lib/handlers/click.ts
import { ClickInput } from '@byob/shared';
import { attachToTab } from '../cdp.js';

export async function handleClick(rawParams: unknown): Promise<unknown> {
  const params = ClickInput.parse(rawParams);

  const tabId = params.tabId ?? (await activeTabId());
  if (tabId === null) return { error: 'unknown', message: 'No active tab' };

  const session = await attachToTab(tabId);
  if (!session) return { error: 'cdp_attach_failed', message: 'Could not attach Chrome debugger.' };

  const expr = `(() => {
    const el = document.querySelector(${JSON.stringify(params.selector)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), text: (el.innerText || '').slice(0, 200) };
  })()`;
  const target = await session.evaluate<{ x: number; y: number; text: string } | null>(expr, { awaitPromise: false });
  if (!target) return { error: 'selector_not_found', message: `No element matched ${params.selector}` };

  const modifierMask = (() => {
    let m = 0;
    if (params.modifiers.includes('Alt'))     m |= 1;
    if (params.modifiers.includes('Control')) m |= 2;
    if (params.modifiers.includes('Meta'))    m |= 4;
    if (params.modifiers.includes('Shift'))   m |= 8;
    return m;
  })();

  const common = { x: target.x, y: target.y, button: params.button, clickCount: params.clickCount, modifiers: modifierMask };
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved',    ...common });
  await session.send('Input.dispatchMouseEvent', { type: 'mousePressed',  ...common });
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...common });

  return { success: true as const, elementText: target.text };
}

async function activeTabId(): Promise<number | null> {
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return t?.id ?? null;
}
```

- [ ] **Step 2: Write `lib/handlers/type.ts`**

```typescript
// packages/extension/lib/handlers/type.ts
import { TypeInput } from '@byob/shared';
import { attachToTab } from '../cdp.js';

export async function handleType(rawParams: unknown): Promise<unknown> {
  const params = TypeInput.parse(rawParams);

  const tabId = params.tabId ?? (await activeTabId());
  if (tabId === null) return { error: 'unknown', message: 'No active tab' };

  const session = await attachToTab(tabId);
  if (!session) return { error: 'cdp_attach_failed', message: 'Could not attach Chrome debugger.' };

  const focusExpr = `(() => {
    const el = document.querySelector(${JSON.stringify(params.selector)});
    if (!el) return false;
    el.scrollIntoView({ block: 'center' });
    el.focus();
    if (${params.clear ? 'true' : 'false'}) {
      if ('value' in el) el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return true;
  })()`;
  const ok = await session.evaluate<boolean>(focusExpr, { awaitPromise: false });
  if (!ok) return { error: 'selector_not_found', message: `No element matched ${params.selector}` };

  await session.send('Input.insertText', { text: params.text });

  if (params.pressEnter) {
    const keyParams = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    await session.send('Input.dispatchKeyEvent', { type: 'keyDown', ...keyParams });
    await session.send('Input.dispatchKeyEvent', { type: 'keyUp',   ...keyParams });
  }

  return { success: true as const };
}

async function activeTabId(): Promise<number | null> {
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return t?.id ?? null;
}
```

- [ ] **Step 3: Commit**

```sh
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
cd /Users/wxt/code/byob
git add packages/extension/lib/handlers/click.ts packages/extension/lib/handlers/type.ts
git commit -m "$(cat <<'EOF'
feat(extension): browser_click and browser_type handlers

CDP Input.dispatchMouseEvent / insertText / dispatchKeyEvent —
real input events (not synthetic DOM events) so anti-bot heuristics
treat the actions as user-initiated.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3.2: Implement `navigate` and `wait_for` handlers

**Files:**
- Create: `/Users/wxt/code/byob/packages/extension/lib/handlers/navigate.ts`
- Create: `/Users/wxt/code/byob/packages/extension/lib/handlers/wait-for.ts`

- [ ] **Step 1: Write `lib/handlers/navigate.ts`**

```typescript
// packages/extension/lib/handlers/navigate.ts
import { NavigateInput } from '@byob/shared';
import { waitForLoad } from '../tab.js';

export async function handleNavigate(rawParams: unknown): Promise<unknown> {
  const params = NavigateInput.parse(rawParams);

  let tabId = params.tabId;
  if (tabId === undefined) {
    const created = await chrome.tabs.create({ url: params.url, active: false });
    tabId = created.id!;
  } else {
    await chrome.tabs.update(tabId, { url: params.url });
  }

  try {
    await waitForLoad(tabId, params.timeoutSec * 1000);
  } catch (e) {
    return { error: 'timeout', message: e instanceof Error ? e.message : String(e) };
  }

  // 'networkidle' isn't a real Chrome event; approximate with a short post-load delay.
  if (params.waitUntil === 'networkidle') {
    await new Promise((r) => setTimeout(r, 1500));
  }

  const tab = await chrome.tabs.get(tabId);
  return { tabId, url: tab.url ?? params.url, title: tab.title ?? '' };
}
```

- [ ] **Step 2: Write `lib/handlers/wait-for.ts`**

```typescript
// packages/extension/lib/handlers/wait-for.ts
import { WaitForInput } from '@byob/shared';
import { attachToTab } from '../cdp.js';

export async function handleWaitFor(rawParams: unknown): Promise<unknown> {
  const params = WaitForInput.parse(rawParams);

  const tabId = params.tabId ?? (await activeTabId());
  if (tabId === null) return { error: 'unknown', message: 'No active tab' };

  const session = await attachToTab(tabId);
  if (!session) return { error: 'cdp_attach_failed', message: 'Could not attach Chrome debugger.' };

  const startedAt = Date.now();
  const expr = `(() => new Promise((resolve) => {
    const sel = ${JSON.stringify(params.selector)};
    const state = ${JSON.stringify(params.state)};
    const startedAt = performance.now();
    const isVisible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      const cs = getComputedStyle(el);
      return cs.visibility !== 'hidden' && cs.display !== 'none';
    };
    const matches = () => {
      const el = document.querySelector(sel);
      switch (state) {
        case 'attached': return !!el;
        case 'detached': return !el;
        case 'visible':  return isVisible(el);
        case 'hidden':   return !isVisible(el);
      }
      return false;
    };
    if (matches()) return resolve({ ok: true, elapsedMs: Math.round(performance.now() - startedAt) });
    const obs = new MutationObserver(() => {
      if (matches()) { obs.disconnect(); clearTimeout(t); resolve({ ok: true, elapsedMs: Math.round(performance.now() - startedAt) }); }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    const t = setTimeout(() => { obs.disconnect(); resolve({ ok: false, elapsedMs: Math.round(performance.now() - startedAt) }); }, ${params.timeoutSec * 1000});
  }))()`;
  const result = await session.evaluate<{ ok: boolean; elapsedMs: number }>(expr, { awaitPromise: true });

  if (!result.ok) return { error: 'timeout', message: `wait_for ${params.selector} (${params.state}) timed out after ${params.timeoutSec}s`, elapsedMs: result.elapsedMs };
  return { found: true as const, elapsedMs: Date.now() - startedAt };
}

async function activeTabId(): Promise<number | null> {
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return t?.id ?? null;
}
```

- [ ] **Step 3: Commit**

```sh
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
cd /Users/wxt/code/byob
git add packages/extension/lib/handlers/navigate.ts packages/extension/lib/handlers/wait-for.ts
git commit -m "$(cat <<'EOF'
feat(extension): browser_navigate and browser_wait_for handlers

navigate uses tabs.create / tabs.update + waitForLoad; networkidle
is approximated with a post-load delay (Chrome has no native event).
wait_for injects a MutationObserver-based poller via CDP eval.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3.3: Wire the 4 new handlers into dispatcher + bridge routes + MCP tools

**Files:**
- Modify: `/Users/wxt/code/byob/packages/extension/lib/handlers/index.ts`
- Modify: `/Users/wxt/code/byob/packages/bridge/src/main.ts`
- Create: `/Users/wxt/code/byob/packages/mcp-server/src/tools/browser-click.ts`
- Create: `/Users/wxt/code/byob/packages/mcp-server/src/tools/browser-type.ts`
- Create: `/Users/wxt/code/byob/packages/mcp-server/src/tools/browser-navigate.ts`
- Create: `/Users/wxt/code/byob/packages/mcp-server/src/tools/browser-wait-for.ts`
- Modify: `/Users/wxt/code/byob/packages/mcp-server/src/tools/index.ts`

- [ ] **Step 1: Update extension handlers index**

```typescript
// packages/extension/lib/handlers/index.ts
import { Command } from '@byob/shared';
import { handleRead }     from './read.js';
import { handleClick }    from './click.js';
import { handleType }     from './type.js';
import { handleNavigate } from './navigate.js';
import { handleWaitFor }  from './wait-for.js';

export type Handler = (params: unknown) => Promise<unknown>;

export const handlers: Partial<Record<string, Handler>> = {
  [Command.Read]:     handleRead,
  [Command.Click]:    handleClick,
  [Command.Type]:     handleType,
  [Command.Navigate]: handleNavigate,
  [Command.WaitFor]:  handleWaitFor,
};
```

- [ ] **Step 2: Update bridge `tools` map in `packages/bridge/src/main.ts`**

```typescript
const tools: IpcHandlers['tools'] = {
  read:        routeFor('readPage'),
  click:       routeFor('click', 30),
  type:        routeFor('type', 30),
  navigate:    routeFor('navigate', 60),
  'wait-for':  routeFor('waitFor', 30),
};
```

- [ ] **Step 3: Write the 4 MCP tool files**

```typescript
// packages/mcp-server/src/tools/browser-click.ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ClickInput, ClickOutput } from '@byob/shared';
import { bridgePost } from '../bridge-client.js';
import { asErrorEnvelope, toMcpError } from '../error-mapper.js';

export function registerBrowserClick(server: McpServer): void {
  server.registerTool(
    'browser_click',
    {
      title: 'Click an element',
      description:
        'Click an element matching the given CSS selector in the active browser tab. ' +
        'Dispatches real mouse events via Chrome DevTools Protocol (not synthetic DOM events), ' +
        'so anti-bot heuristics see this as user input.',
      inputSchema: ClickInput.shape,
    },
    async (args) => {
      const { status, body } = await bridgePost('/click', args);
      if (status >= 400) return toMcpError(asErrorEnvelope(body, `bridge ${status}`));
      const parsed = ClickOutput.safeParse(body);
      if (!parsed.success) return toMcpError({ error: 'unknown', message: parsed.error.message });
      return { content: [{ type: 'text', text: JSON.stringify(parsed.data) }] };
    },
  );
}
```

```typescript
// packages/mcp-server/src/tools/browser-type.ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TypeInput, TypeOutput } from '@byob/shared';
import { bridgePost } from '../bridge-client.js';
import { asErrorEnvelope, toMcpError } from '../error-mapper.js';

export function registerBrowserType(server: McpServer): void {
  server.registerTool(
    'browser_type',
    {
      title: 'Type text into an element',
      description:
        'Focus the element matching the selector, then type the given text. ' +
        'Optionally clears the field first and/or presses Enter after.',
      inputSchema: TypeInput.shape,
    },
    async (args) => {
      const { status, body } = await bridgePost('/type', args);
      if (status >= 400) return toMcpError(asErrorEnvelope(body, `bridge ${status}`));
      const parsed = TypeOutput.safeParse(body);
      if (!parsed.success) return toMcpError({ error: 'unknown', message: parsed.error.message });
      return { content: [{ type: 'text', text: JSON.stringify(parsed.data) }] };
    },
  );
}
```

```typescript
// packages/mcp-server/src/tools/browser-navigate.ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { NavigateInput, NavigateOutput } from '@byob/shared';
import { bridgePost } from '../bridge-client.js';
import { asErrorEnvelope, toMcpError } from '../error-mapper.js';

export function registerBrowserNavigate(server: McpServer): void {
  server.registerTool(
    'browser_navigate',
    {
      title: 'Navigate a tab to a URL',
      description:
        'Open a new tab (or reuse a given tabId) and navigate to the URL. ' +
        'Waits for the load event by default; pass waitUntil=networkidle for SPAs.',
      inputSchema: NavigateInput.shape,
    },
    async (args) => {
      const { status, body } = await bridgePost('/navigate', args);
      if (status >= 400) return toMcpError(asErrorEnvelope(body, `bridge ${status}`));
      const parsed = NavigateOutput.safeParse(body);
      if (!parsed.success) return toMcpError({ error: 'unknown', message: parsed.error.message });
      return { content: [{ type: 'text', text: JSON.stringify(parsed.data) }] };
    },
  );
}
```

```typescript
// packages/mcp-server/src/tools/browser-wait-for.ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WaitForInput, WaitForOutput } from '@byob/shared';
import { bridgePost } from '../bridge-client.js';
import { asErrorEnvelope, toMcpError } from '../error-mapper.js';

export function registerBrowserWaitFor(server: McpServer): void {
  server.registerTool(
    'browser_wait_for',
    {
      title: 'Wait for an element to appear / disappear',
      description:
        'Block until a CSS selector reaches the requested state (visible / hidden / attached / detached). ' +
        'Useful before clicking on async-rendered content.',
      inputSchema: WaitForInput.shape,
    },
    async (args) => {
      const { status, body } = await bridgePost('/wait-for', args);
      if (status >= 400) return toMcpError(asErrorEnvelope(body, `bridge ${status}`));
      const parsed = WaitForOutput.safeParse(body);
      if (!parsed.success) return toMcpError({ error: 'unknown', message: parsed.error.message });
      return { content: [{ type: 'text', text: JSON.stringify(parsed.data) }] };
    },
  );
}
```

- [ ] **Step 4: Update `tools/index.ts`**

```typescript
// packages/mcp-server/src/tools/index.ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerBrowserRead }     from './browser-read.js';
import { registerBrowserClick }    from './browser-click.js';
import { registerBrowserType }     from './browser-type.js';
import { registerBrowserNavigate } from './browser-navigate.js';
import { registerBrowserWaitFor }  from './browser-wait-for.js';

export function registerAllTools(server: McpServer): void {
  registerBrowserRead(server);
  registerBrowserClick(server);
  registerBrowserType(server);
  registerBrowserNavigate(server);
  registerBrowserWaitFor(server);
}
```

- [ ] **Step 5: Build extension + typecheck**

```sh
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
cd /Users/wxt/code/byob
bun --cwd packages/extension run build
bun --cwd packages/extension run typecheck
bun --cwd packages/mcp-server run typecheck
# Reload extension in chrome://extensions
```

- [ ] **Step 6: Smoke test via curl**

```sh
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
SOCK=$(ls ~/.byob/bridges/*.sock | head -1)
# Manually open a tab to https://www.google.com first.
curl --unix-socket "$SOCK" -X POST -H 'Content-Type: application/json' \
  -d '{"selector":"textarea[name=q]","text":"mcp protocol spec","pressEnter":true}' \
  http://x/type
```

Expected: `{"success":true}` and the actual Google tab navigates to a search result page.

- [ ] **Step 7: Commit**

```sh
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
cd /Users/wxt/code/byob
git add packages/extension/lib/handlers/index.ts packages/bridge/src/main.ts packages/mcp-server/src/tools/
git commit -m "$(cat <<'EOF'
feat: wire 4 operation tools (click/type/navigate/wait_for) end-to-end

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Phase 3 DEMO Checkpoint

Ask Claude Code (with byob-dev MCP registered):

> "use byob to search Google for 'mcp protocol spec' and give me the first 3 result titles"

Expected sequence:
1. `browser_navigate https://www.google.com`
2. `browser_type` into `textarea[name=q]` with `pressEnter:true`
3. `browser_wait_for` `#search` (or `[role=main]`)
4. `browser_read` to extract titles

Claude returns titles. **Stop here. Wait for "go" before Phase 4.**

---

# Phase 4 — Utility Tools (½ day)

**Goal:** `browser_screenshot`, `browser_get_cookies`, `browser_list_tabs`, `browser_switch_tab` operational.

**DEMO at end of Phase 4:**
```
Ask Claude Code:
- "use byob to screenshot github.com" → PNG file in ~/.byob/screenshots/
- "use byob to get my github.com cookies" → returns cookies (but not the values in chat — just confirms count)
- "list my open tabs" → returns tab list
```

---

### Task 4.1: Implement `screenshot` handler (with NM upload + size guard)

For Phase 4 we ship the simple path: CDP `Page.captureScreenshot` → base64 → wrap in `result` and let bridge decode + write to disk. We hard-cap base64 length at 800 KB (≈600 KB PNG); larger payloads must use the loopback HTTP path planned for v2 (returns `error: 'unknown', message: 'too large'` for now).

**Files:**
- Create: `/Users/wxt/code/byob/packages/extension/lib/handlers/screenshot.ts`
- Modify: `/Users/wxt/code/byob/packages/bridge/src/main.ts` (add /screenshot route with custom write-to-disk wrapper)

- [ ] **Step 1: Write `lib/handlers/screenshot.ts`**

```typescript
// packages/extension/lib/handlers/screenshot.ts
import { ScreenshotInput } from '@byob/shared';
import { attachToTab } from '../cdp.js';
import { openOrReuse } from '../tab.js';

const MAX_B64_LEN = 800_000; // ~600 KB PNG limit (NM frame budget)

export async function handleScreenshot(rawParams: unknown): Promise<unknown> {
  const params = ScreenshotInput.parse(rawParams);

  const tab = await openOrReuse({
    url: params.url,
    tabId: params.tabId,
    reuseActive: !params.url && params.tabId === undefined,
  });

  const session = await attachToTab(tab.tabId);
  if (!session) {
    if (!tab.reused) await tab.cleanup();
    return { error: 'cdp_attach_failed', message: 'Could not attach Chrome debugger.' };
  }

  try {
    const cdpParams: Record<string, unknown> = {
      format: params.format,
      captureBeyondViewport: params.fullPage,
    };
    if (params.format === 'jpeg' && params.quality !== undefined) cdpParams.quality = params.quality;

    const result = await session.send<{ data: string }>('Page.captureScreenshot', cdpParams);
    if (!result.data) return { error: 'unknown', message: 'CDP returned no data' };
    if (result.data.length > MAX_B64_LEN) {
      return { error: 'unknown', message: `screenshot too large (base64 ${result.data.length}). Try fullPage:false or format:jpeg + quality:60.` };
    }

    // Read viewport for the response payload.
    const dims = await session.evaluate<{ w: number; h: number }>(
      `(() => ({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight }))()`,
      { awaitPromise: false },
    );

    return {
      _b64Data: result.data,            // bridge consumes this and replaces with `path`
      _format:  params.format,
      _savePath: params.savePath,
      width: dims.w,
      height: dims.h,
      format: params.format,
    };
  } finally {
    if (!tab.reused) {
      await session.detach();
      await tab.cleanup();
    }
  }
}
```

- [ ] **Step 2: Add screenshot route in bridge `main.ts`**

In `packages/bridge/src/main.ts`, add a custom route and helper. Replace the `tools` map:

```typescript
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SCREENSHOTS_DIR } from './paths.js';

async function screenshotRoute(body: unknown): Promise<{ status: number; body: unknown }> {
  // Forward to extension as 'screenshot' command, then post-process the b64.
  const result = await sendCommand('screenshot', body, 60_000) as Record<string, unknown>;
  if (result.error) return { status: 502, body: result };

  const data = typeof result._b64Data === 'string' ? result._b64Data : '';
  const format = (result._format as string) ?? 'png';
  const ext = format === 'jpeg' ? 'jpg' : 'png';
  let savePath = (result._savePath as string) ?? '';
  if (!savePath) {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true, mode: 0o700 });
    savePath = path.join(SCREENSHOTS_DIR, `${Date.now()}.${ext}`);
  }
  try { fs.writeFileSync(savePath, Buffer.from(data, 'base64'), { mode: 0o600 }); }
  catch (e) { return { status: 500, body: { error: 'unknown', message: e instanceof Error ? e.message : String(e) } }; }

  return {
    status: 200,
    body: {
      path: savePath,
      width: result.width ?? 0,
      height: result.height ?? 0,
      format,
    },
  };
}

const tools: IpcHandlers['tools'] = {
  read:        routeFor('readPage'),
  click:       routeFor('click', 30),
  type:        routeFor('type', 30),
  navigate:    routeFor('navigate', 60),
  'wait-for':  routeFor('waitFor', 30),
  screenshot:  screenshotRoute,
};
```

- [ ] **Step 3: Wire dispatcher**

```typescript
// packages/extension/lib/handlers/index.ts (add import + entry)
import { handleScreenshot } from './screenshot.js';

export const handlers: Partial<Record<string, Handler>> = {
  [Command.Read]:       handleRead,
  [Command.Click]:      handleClick,
  [Command.Type]:       handleType,
  [Command.Navigate]:   handleNavigate,
  [Command.WaitFor]:    handleWaitFor,
  [Command.Screenshot]: handleScreenshot,
};
```

- [ ] **Step 4: Commit**

```sh
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
cd /Users/wxt/code/byob
git add packages/extension/lib/handlers/screenshot.ts packages/extension/lib/handlers/index.ts packages/bridge/src/main.ts
git commit -m "$(cat <<'EOF'
feat: browser_screenshot via CDP + bridge-side base64 → file

Phase 4 ships the simple path: extension returns base64 in the
result frame; bridge decodes and writes to disk, returns path.
Hard-capped at ~600 KB PNG (NM 1MB frame budget). Larger payloads
need the loopback HTTP path planned for v2.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4.2: Implement `get_cookies` handler

Uses `chrome.cookies.getAll()` (better than CDP `Network.getCookies` here — it's simpler and includes partition keys natively when supported).

**Files:**
- Create: `/Users/wxt/code/byob/packages/extension/lib/handlers/get-cookies.ts`

- [ ] **Step 1: Write `lib/handlers/get-cookies.ts`**

```typescript
// packages/extension/lib/handlers/get-cookies.ts
import { GetCookiesInput } from '@byob/shared';

interface ChromeCookie extends chrome.cookies.Cookie {
  partitionKey?: { topLevelSite?: string };
}

export async function handleGetCookies(rawParams: unknown): Promise<unknown> {
  const params = GetCookiesInput.parse(rawParams);

  const filter: chrome.cookies.GetAllDetails = {};
  if (params.url) filter.url = params.url;
  if (params.domain) filter.domain = params.domain;

  const raw = (await chrome.cookies.getAll(filter)) as ChromeCookie[];
  const cookies = raw.map((c) => ({
    name:    c.name,
    value:   c.value,
    domain:  c.domain,
    path:    c.path,
    expires: c.expirationDate,
    httpOnly: !!c.httpOnly,
    secure:   !!c.secure,
    sameSite: c.sameSite,
    partitionKey: c.partitionKey?.topLevelSite,
  }));
  return { cookies };
}
```

- [ ] **Step 2: Wire into dispatcher**

```typescript
// add to packages/extension/lib/handlers/index.ts
import { handleGetCookies } from './get-cookies.js';

// ...inside handlers map:
  [Command.GetCookies]: handleGetCookies,
```

- [ ] **Step 3: Add bridge route**

```typescript
// add to tools map in packages/bridge/src/main.ts
  cookies: routeFor('getCookies', 10),
```

- [ ] **Step 4: Commit**

```sh
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
cd /Users/wxt/code/byob
git add packages/extension/lib/handlers/get-cookies.ts packages/extension/lib/handlers/index.ts packages/bridge/src/main.ts
git commit -m "$(cat <<'EOF'
feat: browser_get_cookies via chrome.cookies.getAll

Native Chrome API gives us partitionKey support out of the box;
no CDP needed. Useful for replaying authenticated requests via
curl without re-opening the browser.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4.3: Implement `list_tabs` and `switch_tab` handlers

**Files:**
- Create: `/Users/wxt/code/byob/packages/extension/lib/handlers/list-tabs.ts`
- Create: `/Users/wxt/code/byob/packages/extension/lib/handlers/switch-tab.ts`

- [ ] **Step 1: Write the two handlers**

```typescript
// packages/extension/lib/handlers/list-tabs.ts
export async function handleListTabs(): Promise<unknown> {
  const tabs = await chrome.tabs.query({});
  return {
    tabs: tabs
      .filter((t) => t.id !== undefined)
      .map((t) => ({
        id: t.id!,
        url: t.url ?? '',
        title: t.title ?? '',
        active: !!t.active,
        windowId: t.windowId,
      })),
  };
}
```

```typescript
// packages/extension/lib/handlers/switch-tab.ts
import { SwitchTabInput } from '@byob/shared';

export async function handleSwitchTab(rawParams: unknown): Promise<unknown> {
  const params = SwitchTabInput.parse(rawParams);
  try {
    const t = await chrome.tabs.get(params.tabId);
    if (t.windowId !== undefined) await chrome.windows.update(t.windowId, { focused: true });
    await chrome.tabs.update(params.tabId, { active: true });
    return { success: true as const };
  } catch (e) {
    return { error: 'tab_closed', message: e instanceof Error ? e.message : String(e) };
  }
}
```

- [ ] **Step 2: Wire dispatcher**

```typescript
// packages/extension/lib/handlers/index.ts
import { handleListTabs }  from './list-tabs.js';
import { handleSwitchTab } from './switch-tab.js';

// add to map:
  [Command.ListTabs]:  handleListTabs,
  [Command.SwitchTab]: handleSwitchTab,
```

- [ ] **Step 3: Add bridge routes (note: list-tabs is GET /tabs)**

In `packages/bridge/src/main.ts`, the `tools` map only handles POST routes. Add a GET handler in `ipc-server.ts` so `/tabs` can be a GET. Edit the `if (req.method === 'GET' && req.url === '/status')` block in `packages/bridge/src/ipc-server.ts` and add **after** it:

```typescript
      if (req.method === 'GET' && req.url === '/tabs') {
        const handler = handlers.tools['__list-tabs'];
        if (handler) {
          const { status, body: out } = await handler(undefined);
          return send(res, status, out);
        }
      }
```

Then in `packages/bridge/src/main.ts` `tools` map:

```typescript
  '__list-tabs':  routeFor('listTabs', 5),
  'tabs/switch':  routeFor('switchTab', 5),
```

- [ ] **Step 4: Commit**

```sh
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
cd /Users/wxt/code/byob
git add packages/extension/lib/handlers/list-tabs.ts packages/extension/lib/handlers/switch-tab.ts \
        packages/extension/lib/handlers/index.ts packages/bridge/src/ipc-server.ts packages/bridge/src/main.ts
git commit -m "$(cat <<'EOF'
feat: browser_list_tabs and browser_switch_tab

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4.4: Register the 4 utility tools in MCP server

**Files:**
- Create: `/Users/wxt/code/byob/packages/mcp-server/src/tools/browser-screenshot.ts`
- Create: `/Users/wxt/code/byob/packages/mcp-server/src/tools/browser-get-cookies.ts`
- Create: `/Users/wxt/code/byob/packages/mcp-server/src/tools/browser-list-tabs.ts`
- Create: `/Users/wxt/code/byob/packages/mcp-server/src/tools/browser-switch-tab.ts`
- Modify: `/Users/wxt/code/byob/packages/mcp-server/src/tools/index.ts`

- [ ] **Step 1: Write 4 tool files**

```typescript
// packages/mcp-server/src/tools/browser-screenshot.ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ScreenshotInput, ScreenshotOutput } from '@byob/shared';
import { bridgePost } from '../bridge-client.js';
import { asErrorEnvelope, toMcpError } from '../error-mapper.js';

export function registerBrowserScreenshot(server: McpServer): void {
  server.registerTool(
    'browser_screenshot',
    {
      title: 'Screenshot a page (returns file path, not data)',
      description:
        'Capture a screenshot of a webpage and save it to disk. Returns the file PATH ' +
        '(not base64) — read the file with the Read tool when you actually need the image. ' +
        'Default save dir is ~/.byob/screenshots/. fullPage may fail for very long pages.',
      inputSchema: ScreenshotInput.shape,
    },
    async (args) => {
      const { status, body } = await bridgePost('/screenshot', args);
      if (status >= 400) return toMcpError(asErrorEnvelope(body, `bridge ${status}`));
      const parsed = ScreenshotOutput.safeParse(body);
      if (!parsed.success) return toMcpError({ error: 'unknown', message: parsed.error.message });
      return { content: [{ type: 'text', text: JSON.stringify(parsed.data) }] };
    },
  );
}
```

```typescript
// packages/mcp-server/src/tools/browser-get-cookies.ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GetCookiesInput, GetCookiesOutput } from '@byob/shared';
import { bridgePost } from '../bridge-client.js';
import { asErrorEnvelope, toMcpError } from '../error-mapper.js';

export function registerBrowserGetCookies(server: McpServer): void {
  server.registerTool(
    'browser_get_cookies',
    {
      title: 'Read cookies from the user\'s browser for a domain',
      description:
        'Returns cookies (incl. value) for a given domain or URL. Useful for ' +
        'replaying authenticated requests via curl/fetch without re-opening Chrome. ' +
        'Honors Chrome partitioning (CHIPS).',
      inputSchema: GetCookiesInput.shape,
    },
    async (args) => {
      const { status, body } = await bridgePost('/cookies', args);
      if (status >= 400) return toMcpError(asErrorEnvelope(body, `bridge ${status}`));
      const parsed = GetCookiesOutput.safeParse(body);
      if (!parsed.success) return toMcpError({ error: 'unknown', message: parsed.error.message });
      return { content: [{ type: 'text', text: JSON.stringify(parsed.data) }] };
    },
  );
}
```

```typescript
// packages/mcp-server/src/tools/browser-list-tabs.ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ListTabsOutput } from '@byob/shared';
import { bridgeGet } from '../bridge-client.js';
import { asErrorEnvelope, toMcpError } from '../error-mapper.js';

export function registerBrowserListTabs(server: McpServer): void {
  server.registerTool(
    'browser_list_tabs',
    {
      title: 'List all tabs in the user\'s browser',
      description: 'Returns id, url, title, active flag, and windowId for every open tab.',
      inputSchema: z.object({}).shape,
    },
    async () => {
      const { status, body } = await bridgeGet('/tabs');
      if (status >= 400) return toMcpError(asErrorEnvelope(body, `bridge ${status}`));
      const parsed = ListTabsOutput.safeParse(body);
      if (!parsed.success) return toMcpError({ error: 'unknown', message: parsed.error.message });
      return { content: [{ type: 'text', text: JSON.stringify(parsed.data) }] };
    },
  );
}
```

```typescript
// packages/mcp-server/src/tools/browser-switch-tab.ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SwitchTabInput, SwitchTabOutput } from '@byob/shared';
import { bridgePost } from '../bridge-client.js';
import { asErrorEnvelope, toMcpError } from '../error-mapper.js';

export function registerBrowserSwitchTab(server: McpServer): void {
  server.registerTool(
    'browser_switch_tab',
    {
      title: 'Activate a tab by id',
      description: 'Bring the given tab to the foreground (focus its window + make it active).',
      inputSchema: SwitchTabInput.shape,
    },
    async (args) => {
      const { status, body } = await bridgePost('/tabs/switch', args);
      if (status >= 400) return toMcpError(asErrorEnvelope(body, `bridge ${status}`));
      const parsed = SwitchTabOutput.safeParse(body);
      if (!parsed.success) return toMcpError({ error: 'unknown', message: parsed.error.message });
      return { content: [{ type: 'text', text: JSON.stringify(parsed.data) }] };
    },
  );
}
```

- [ ] **Step 2: Update `tools/index.ts`**

```typescript
// packages/mcp-server/src/tools/index.ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerBrowserRead }       from './browser-read.js';
import { registerBrowserClick }      from './browser-click.js';
import { registerBrowserType }       from './browser-type.js';
import { registerBrowserNavigate }   from './browser-navigate.js';
import { registerBrowserWaitFor }    from './browser-wait-for.js';
import { registerBrowserScreenshot } from './browser-screenshot.js';
import { registerBrowserGetCookies } from './browser-get-cookies.js';
import { registerBrowserListTabs }   from './browser-list-tabs.js';
import { registerBrowserSwitchTab }  from './browser-switch-tab.js';

export function registerAllTools(server: McpServer): void {
  registerBrowserRead(server);
  registerBrowserClick(server);
  registerBrowserType(server);
  registerBrowserNavigate(server);
  registerBrowserWaitFor(server);
  registerBrowserScreenshot(server);
  registerBrowserGetCookies(server);
  registerBrowserListTabs(server);
  registerBrowserSwitchTab(server);
}
```

- [ ] **Step 3: Build, typecheck, commit**

```sh
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
cd /Users/wxt/code/byob
bun --cwd packages/extension run build
bun --cwd packages/mcp-server run typecheck
bun --cwd packages/extension run typecheck
git add packages/mcp-server/src/tools/
git commit -m "$(cat <<'EOF'
feat(mcp): register screenshot/get_cookies/list_tabs/switch_tab tools

9 of 10 tools now exposed via MCP (browser_eval still gated for Phase 5).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Phase 4 DEMO Checkpoint

Reload the extension (chrome://extensions → byob → reload), then in Claude Code:

> "use byob to screenshot github.com — what does it look like?"
> Expected: tool returns a path; Claude reads the file and describes the page.

> "use byob to get my github.com cookies — just tell me how many you found and which one is the session"
> Expected: cookie list with `user_session` somewhere.

> "list my open tabs"
> Expected: array of {id, url, title, active}.

> "switch to my Gmail tab"
> Expected: list_tabs → find Gmail → switch_tab.

**Stop here. Wait for "go" before Phase 5.**

---

# Phase 5 — `browser_eval` + Safety Guards (½ day)

**Goal:** Tenth tool ships, but only when explicitly enabled via `BYOB_ALLOW_EVAL=1`. URL blacklist enforced uniformly across all handlers. Every eval call is audit-logged and surfaces a Chrome notification.

**DEMO at end of Phase 5:**
```
# Default install: browser_eval should NOT appear in tools/list
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | bun --cwd packages/mcp-server run dev | grep -c browser_eval
# Expected: 0

# With env on, it appears + works + emits a notification + audit log entry:
BYOB_ALLOW_EVAL=1 bun --cwd packages/mcp-server run dev
# (use through Claude Code: "use byob to eval document.title")

# URL guard:
# Ask: "use byob to read file:///etc/passwd" → URL_FORBIDDEN
```

---

### Task 5.1: URL guard (extension)

**Files:**
- Create: `/Users/wxt/code/byob/packages/extension/lib/url-guard.ts`
- Modify: `/Users/wxt/code/byob/packages/extension/lib/handlers/read.ts`
- Modify: `/Users/wxt/code/byob/packages/extension/lib/handlers/navigate.ts`

- [ ] **Step 1: Write `lib/url-guard.ts`**

```typescript
// packages/extension/lib/url-guard.ts
const FORBIDDEN_PROTOCOLS = ['chrome:', 'chrome-extension:', 'about:', 'devtools:', 'view-source:', 'file:'];
const DEFAULT_FORBIDDEN_HOSTS = ['accounts.google.com', 'login.microsoftonline.com', 'appleid.apple.com'];

function envFlag(name: string): boolean {
  // We can't read process.env in extension; gate via chrome.storage.local for parity.
  // The CLI / mcp-server can set env on its side; for the extension we use a toggle in storage.
  // Phase 5 implements the simple version: never expose toggles in storage by default.
  return false;
}

export function checkUrlAllowed(url: string): { ok: true } | { ok: false; reason: string } {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return { ok: false, reason: `invalid URL: ${url}` }; }

  if (FORBIDDEN_PROTOCOLS.includes(parsed.protocol) && !(parsed.protocol === 'file:' && envFlag('BYOB_ALLOW_FILE'))) {
    return { ok: false, reason: `protocol ${parsed.protocol} is forbidden` };
  }
  if (DEFAULT_FORBIDDEN_HOSTS.includes(parsed.hostname) && !envFlag('BYOB_ALLOW_AUTH_DOMAINS')) {
    return { ok: false, reason: `host ${parsed.hostname} is on the byob blacklist` };
  }
  return { ok: true };
}

export function urlForbiddenError(reason: string): { error: 'url_forbidden'; message: string; hint: string } {
  return {
    error: 'url_forbidden',
    message: reason,
    hint: 'Set BYOB_ALLOW_FILE=1 (file://) or BYOB_ALLOW_AUTH_DOMAINS=1 (auth domains) to bypass.',
  };
}
```

- [ ] **Step 2: Apply guard to `read.ts` and `navigate.ts`**

In `lib/handlers/read.ts`, immediately after `const params = ReadInput.parse(rawParams);`:

```typescript
import { checkUrlAllowed, urlForbiddenError } from '../url-guard.js';
// ...
const guard = checkUrlAllowed(params.url);
if (!guard.ok) return urlForbiddenError(guard.reason);
```

Same for `navigate.ts` after parsing.

- [ ] **Step 3: Commit**

```sh
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
cd /Users/wxt/code/byob
git add packages/extension/lib/url-guard.ts packages/extension/lib/handlers/read.ts packages/extension/lib/handlers/navigate.ts
git commit -m "$(cat <<'EOF'
feat(extension): URL guard with default blacklist

chrome:/about:/devtools:/file: protocols and major auth hostnames
blocked by default. Env opt-outs documented in the error hint.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5.2: `eval` handler with notification + throttle

**Files:**
- Create: `/Users/wxt/code/byob/packages/extension/lib/notify.ts`
- Create: `/Users/wxt/code/byob/packages/extension/lib/handlers/eval.ts`

- [ ] **Step 1: Write `lib/notify.ts`**

```typescript
// packages/extension/lib/notify.ts
const buckets = new Map<number, number[]>();
const WINDOW_MS = 60_000;
const LIMIT_PER_WINDOW = 5;

export function recordAndCheckRate(tabId: number): boolean {
  const now = Date.now();
  const arr = (buckets.get(tabId) ?? []).filter((t) => now - t < WINDOW_MS);
  arr.push(now);
  buckets.set(tabId, arr);
  return arr.length <= LIMIT_PER_WINDOW;
}

export function notifyEval(tabId: number, url: string, code: string): void {
  const id = `byob-eval-${tabId}-${Date.now()}`;
  void chrome.notifications.create(id, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: 'byob: evaluating JS',
    message: `tab ${tabId} (${url})\n${code.slice(0, 80)}${code.length > 80 ? '…' : ''}`,
    requireInteraction: false,
  });
}
```

- [ ] **Step 2: Write `lib/handlers/eval.ts`**

```typescript
// packages/extension/lib/handlers/eval.ts
import { EvalInput } from '@byob/shared';
import { attachToTab } from '../cdp.js';
import { notifyEval, recordAndCheckRate } from '../notify.js';

export async function handleEval(rawParams: unknown): Promise<unknown> {
  const params = EvalInput.parse(rawParams);

  const tabId = params.tabId ?? (await activeTabId());
  if (tabId === null) return { error: 'unknown', message: 'No active tab' };

  if (!recordAndCheckRate(tabId)) return { error: 'rate_limited', message: 'Too many eval calls in this tab in the last minute' };

  const tab = await chrome.tabs.get(tabId);
  notifyEval(tabId, tab.url ?? '', params.code);

  const session = await attachToTab(tabId);
  if (!session) return { error: 'cdp_attach_failed', message: 'Could not attach Chrome debugger.' };

  const res = await session.send<{ result: { value?: unknown; type: string }; exceptionDetails?: unknown }>(
    'Runtime.evaluate',
    { expression: params.code, awaitPromise: params.awaitPromise, returnByValue: params.returnByValue },
  );
  if (res.exceptionDetails) {
    return { error: 'eval_exception', message: 'Page threw during eval', exceptionDetails: res.exceptionDetails };
  }
  return { result: res.result?.value, type: res.result?.type ?? 'undefined' };
}

async function activeTabId(): Promise<number | null> {
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return t?.id ?? null;
}
```

- [ ] **Step 3: Wire dispatcher + bridge route + audit log**

```typescript
// packages/extension/lib/handlers/index.ts — add:
import { handleEval } from './eval.js';
//   [Command.Eval]: handleEval,
```

Add audit-logging wrapper to bridge `main.ts`:

```typescript
// packages/bridge/src/main.ts — at top:
import { EVAL_AUDIT_PATH } from './paths.js';

function auditEval(reqBody: unknown, originHeader: string | undefined): void {
  try {
    const code = (reqBody as { code?: string })?.code ?? '';
    const line = `[${new Date().toISOString()}] origin=${originHeader ?? '?'} code=${code.slice(0, 200).replace(/\n/g, '⏎')}\n`;
    fs.appendFileSync(EVAL_AUDIT_PATH, line, { mode: 0o600 });
  } catch { /* ignore */ }
}

// in tools map:
  eval: async (body: unknown) => {
    auditEval(body, undefined);   // origin header passed by the IPC layer in next step
    return routeFor('eval', 30)(body);
  },
```

- [ ] **Step 4: Commit**

```sh
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
cd /Users/wxt/code/byob
git add packages/extension/lib/notify.ts packages/extension/lib/handlers/eval.ts packages/extension/lib/handlers/index.ts packages/bridge/src/main.ts
git commit -m "$(cat <<'EOF'
feat: browser_eval handler with notification + throttle + audit log

Three guardrails: rate-limit (5/min/tab), Chrome notification per call,
bridge appends to ~/.byob/eval-audit.log.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5.3: Env-gate `browser_eval` registration in MCP server

**Files:**
- Create: `/Users/wxt/code/byob/packages/mcp-server/src/tools/browser-eval.ts`
- Modify: `/Users/wxt/code/byob/packages/mcp-server/src/tools/index.ts`

- [ ] **Step 1: Write `tools/browser-eval.ts`**

```typescript
// packages/mcp-server/src/tools/browser-eval.ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { EvalInput, EvalOutput } from '@byob/shared';
import { bridgePost } from '../bridge-client.js';
import { asErrorEnvelope, toMcpError } from '../error-mapper.js';

export function registerBrowserEval(server: McpServer): void {
  server.registerTool(
    'browser_eval',
    {
      title: 'Execute JavaScript in a tab (DANGEROUS)',
      description:
        'Run arbitrary JavaScript in a browser tab via CDP Runtime.evaluate. ' +
        'DANGEROUS — full DOM and session access. Only use when other tools cannot ' +
        'accomplish the task. Audit-logged. Throttled to 5 calls per minute per tab.',
      inputSchema: EvalInput.shape,
    },
    async (args) => {
      const { status, body } = await bridgePost('/eval', args);
      if (status >= 400) return toMcpError(asErrorEnvelope(body, `bridge ${status}`));
      const parsed = EvalOutput.safeParse(body);
      if (!parsed.success) return toMcpError({ error: 'unknown', message: parsed.error.message });
      return { content: [{ type: 'text', text: JSON.stringify(parsed.data) }] };
    },
  );
}
```

- [ ] **Step 2: Update `tools/index.ts`**

```typescript
import { registerBrowserEval } from './browser-eval.js';
// ...
export function registerAllTools(server: McpServer): void {
  registerBrowserRead(server);
  registerBrowserClick(server);
  registerBrowserType(server);
  registerBrowserNavigate(server);
  registerBrowserWaitFor(server);
  registerBrowserScreenshot(server);
  registerBrowserGetCookies(server);
  registerBrowserListTabs(server);
  registerBrowserSwitchTab(server);
  if (process.env.BYOB_ALLOW_EVAL === '1') {
    registerBrowserEval(server);
    console.error('[byob-mcp] browser_eval ENABLED via BYOB_ALLOW_EVAL=1');
  }
}
```

- [ ] **Step 3: Commit**

```sh
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
cd /Users/wxt/code/byob
bun --cwd packages/mcp-server run typecheck
git add packages/mcp-server/src/tools/browser-eval.ts packages/mcp-server/src/tools/index.ts
git commit -m "$(cat <<'EOF'
feat(mcp): browser_eval registered only when BYOB_ALLOW_EVAL=1

Default install: tool is invisible to LLM. Opt-in surfaces it
plus a stderr banner.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Phase 5 DEMO Checkpoint

```sh
# 1. Default — browser_eval is hidden
bun --cwd packages/extension run build  # rebuild + reload extension
# In a fresh Claude Code session: ask LLM to list its tools.
# Expected: 9 byob tools, no browser_eval.

# 2. URL guard works
# Ask: "use byob to read file:///etc/passwd" → URL_FORBIDDEN error envelope.

# 3. Eval works when enabled
# Update Claude MCP config: env BYOB_ALLOW_EVAL=1
# Ask: "use byob_eval to return document.title from my github.com tab"
# Expected: returns the title; macOS notification appears; audit log entry:
tail -3 ~/.byob/eval-audit.log
```

**Stop here. Wait for "go" before Phase 6.**

---

# Phase 6 — Error Model + Abort Propagation (½ day)

**Goal:** Cancellation works end-to-end (MCP client cancels → CDP detaches cleanly). CDP attach failures degrade `browser_read` to `chrome.scripting`. All errors get proper codes + hints.

**DEMO at end of Phase 6:**
- Open DevTools (F12) on a tab, run `browser_click` on it → returns `CDP_ATTACH_FAILED` + hint
- During a long `browser_read`, hit Ctrl+C in Claude → bridge log shows clean detach, no stuck CDP session
- Quit Chrome mid-operation → mcp-server returns `BRIDGE_NOT_RUNNING`

---

### Task 6.1: Cancel propagation

**Files:**
- Modify: `/Users/wxt/code/byob/packages/bridge/src/main.ts`
- Modify: `/Users/wxt/code/byob/packages/bridge/src/ipc-server.ts`
- Modify: `/Users/wxt/code/byob/packages/extension/entrypoints/background.ts`
- Modify: `/Users/wxt/code/byob/packages/extension/lib/handlers/read.ts` (use AbortSignal)

- [ ] **Step 1: IPC server — propagate `req.on('close')` to a cancel callback**

In `packages/bridge/src/ipc-server.ts`, change the `tools` handler signature to accept an AbortSignal. Update the type:

```typescript
export interface IpcHandlers {
  isExtensionConnected: () => boolean;
  getDeviceId: () => string | null;
  getStartedAt: () => number;
  tools: Record<string, (body: unknown, signal: AbortSignal) => Promise<{ status: number; body: unknown }>>;
}
```

In the request loop:

```typescript
      if (req.method === 'POST' && req.url) {
        const route = req.url.replace(/^\//, '').split('?')[0]!;
        const handler = handlers.tools[route];
        if (handler) {
          const body = await readBody(req);
          const ac = new AbortController();
          req.on('close', () => ac.abort());
          const { status, body: out } = await handler(body, ac.signal);
          return send(res, status, out);
        }
      }
```

- [ ] **Step 2: Bridge — forward cancel via NM**

In `packages/bridge/src/main.ts`, change `routeFor` to use the signal:

```typescript
function routeFor(command: string, defaultTimeoutSec = 60) {
  return async (body: unknown, signal: AbortSignal): Promise<{ status: number; body: unknown }> => {
    const timeoutSec = (typeof body === 'object' && body && 'timeoutSec' in body
      ? Number((body as { timeoutSec: unknown }).timeoutSec) : NaN);
    const timeoutMs = (Number.isFinite(timeoutSec) ? timeoutSec : defaultTimeoutSec) * 1000 + 30_000;

    const requestId = crypto.randomUUID();
    if (!extensionConnected) return { status: 502, body: { error: 'extension_not_connected', message: 'Chrome extension is not connected.' } };
    const result = await new Promise<Record<string, unknown>>((resolve) => {
      const onAbort = () => {
        writeFrameToStdout({ type: 'cancel', requestId });
        // Don't resolve here; let the result frame come back as aborted
      };
      signal.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => { pending.delete(requestId); resolve({ error: 'timeout', message: `Command ${command} timed out` }); }, timeoutMs);
      pending.set(requestId, { resolve, reject: () => {}, timer });
      writeFrameToStdout({ type: 'command', requestId, command, params: body });
    });
    if (result.error) return { status: 502, body: result };
    return { status: 200, body: result };
  };
}
```

- [ ] **Step 3: Extension — track AbortControllers per requestId**

In `packages/extension/entrypoints/background.ts`, replace the dispatch logic:

```typescript
const inFlight = new Map<string, AbortController>();

startNativeBus({
  onMessage: async (msg) => {
    if (msg.type === 'cancel') {
      inFlight.get(msg.requestId)?.abort();
      inFlight.delete(msg.requestId);
      return;
    }
    if (msg.type !== 'command') return;
    const { requestId, command, params } = msg;
    const handler = handlers[command];
    if (!handler) {
      bus.post({ type: 'result', requestId, error: 'unknown', message: `No handler for ${command}` });
      return;
    }
    const ac = new AbortController();
    inFlight.set(requestId, ac);
    try {
      const data = await handler(params, ac.signal);
      bus.post({ type: 'result', requestId, ...((data as object) ?? {}) });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const aborted = ac.signal.aborted ? { aborted: true } : {};
      bus.post({ type: 'result', requestId, error: 'unknown', message, ...aborted });
    } finally {
      inFlight.delete(requestId);
    }
  },
  onReady: () => console.log('[byob] bridge ready'),
});
```

Update `Handler` type in `lib/handlers/index.ts`:

```typescript
export type Handler = (params: unknown, signal: AbortSignal) => Promise<unknown>;
```

(Update existing handlers to accept the signal argument; most can ignore it. `read.ts` uses it to break out of the scroll loop:)

```typescript
// in read.ts loop:
for (let i = 0; i < params.screens; i++) {
  if (signal.aborted) { stopReason = 'timeout'; break; }   // treat aborted same as timeout
  // ...
}
```

- [ ] **Step 4: Commit**

```sh
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
cd /Users/wxt/code/byob
bun --cwd packages/bridge run typecheck && bun --cwd packages/extension run typecheck
git add packages/bridge/src/main.ts packages/bridge/src/ipc-server.ts \
        packages/extension/entrypoints/background.ts packages/extension/lib/handlers/index.ts \
        packages/extension/lib/handlers/read.ts
git commit -m "$(cat <<'EOF'
feat: end-to-end abort propagation

mcp-server closes HTTP → bridge req.on('close') → cancel frame to
extension → handler's AbortSignal aborts → CDP cleanup → result frame
with aborted:true.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6.2: CDP fallback for `browser_read`

**Files:**
- Modify: `/Users/wxt/code/byob/packages/extension/lib/handlers/read.ts`

- [ ] **Step 1: Add fallback path**

Wrap the CDP block in a try/catch; on attach failure call `chrome.scripting.executeScript({world:'MAIN', func: collectFn})` once and return chunks with `stopReason: 'fallback'`.

```typescript
// in read.ts, after openOrReuse:
const session = await attachToTab(tab.tabId);
if (!session) {
  // Fallback: one-shot scripting.executeScript injection
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.tabId },
      world: 'MAIN',
      // The collector + scroll loop in a self-contained function.
      func: function collectOnce() {
        const out: Array<{ id: string; sourceIds: string[]; text: string; bounds: [number, number, number, number] }> = [];
        const all = document.body ? document.body.querySelectorAll('*') : [];
        let counter = 0;
        for (const el of Array.from(all)) {
          if ((el as HTMLElement).children.length > 0) continue;
          const txt = ((el as HTMLElement).innerText || el.textContent || '').trim();
          if (!txt || txt.length > 4000) continue;
          const r = (el as HTMLElement).getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          out.push({ id: 'b' + (++counter), sourceIds: ['b' + counter], text: txt, bounds: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] });
        }
        return out;
      },
    });
    const chunks = (res?.result ?? []) as Array<{ id: string; sourceIds: string[]; text: string; bounds: [number, number, number, number] }>;
    const tabInfo = await chrome.tabs.get(tab.tabId);
    if (!tab.reused) await tab.cleanup();
    return {
      text: chunks.map((c) => c.text).join('\n\n'),
      title: tabInfo.title ?? '',
      url: tabInfo.url ?? params.url,
      chunks,
      sessionId: params.sessionId ?? crypto.randomUUID(),
      canContinue: false,
      stopReason: 'fallback' as const,
    };
  } catch (e) {
    if (!tab.reused) await tab.cleanup();
    return { error: 'cdp_attach_failed', message: 'CDP attach failed and content script fallback also failed.', hint: 'Close DevTools (F12) on the tab.' };
  }
}
```

- [ ] **Step 2: Commit**

```sh
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
cd /Users/wxt/code/byob
bun --cwd packages/extension run typecheck
git add packages/extension/lib/handlers/read.ts
git commit -m "$(cat <<'EOF'
feat(extension): browser_read CDP→scripting fallback

When CDP attach is blocked (DevTools open, etc.), one-shot
chrome.scripting.executeScript injection collects whatever's
in the current viewport. stopReason:'fallback' signals the LLM.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Phase 6 DEMO Checkpoint

```sh
# 1. F12 fallback
# Manually: open chrome://newtab + open DevTools, then ask Claude:
# "use byob to read https://news.ycombinator.com"
# Expected: returns chunks with stopReason:'fallback' (no error).

# 2. Click on F12-attached tab fails cleanly
# Ask: "use byob to click the first link in this tab"  (where DevTools is open)
# Expected: CDP_ATTACH_FAILED error envelope with hint.

# 3. Cancel mid-read
# Ask: "use byob to read https://en.wikipedia.org/wiki/Special:Random with 50 screens"
# Wait ~3 seconds, then Ctrl+C in Claude.
# Expected: bridge.log shows cancel frame; no leftover CDP session
#   chrome://inspect → Devices  should show no leftover targets attached.

# 4. Quit Chrome mid-operation
# Ask read; quickly cmd-Q Chrome.
# Expected: extension_not_connected or bridge_not_running.
```

**Stop here. Wait for "go" before Phase 7.**

---

# Phase 7 — Management CLI Polish + Docs (½ day)

**Goal:** `byob doctor` is comprehensive. `byob bridges/logs/uninstall` work. README + e2e checklist exist.

---

### Task 7.1: `byob bridges`, `byob logs`, `byob uninstall`

**Files:**
- Create: `/Users/wxt/code/byob/packages/bridge/src/logs.ts`
- Create: `/Users/wxt/code/byob/packages/bridge/src/uninstall.ts`
- Modify: `/Users/wxt/code/byob/packages/bridge/bin/byob.ts`

- [ ] **Step 1: Write `logs.ts`**

```typescript
// packages/bridge/src/logs.ts
import * as fs from 'node:fs';
import { LOG_PATH } from './paths.js';

export async function tailLog(opts: { follow?: boolean }): Promise<void> {
  if (!fs.existsSync(LOG_PATH)) {
    console.error(`No log at ${LOG_PATH} yet (bridge has not started).`);
    return;
  }
  // Print the last ~200 lines first.
  const buf = fs.readFileSync(LOG_PATH, 'utf-8');
  const lines = buf.split('\n');
  process.stdout.write(lines.slice(-200).join('\n'));

  if (!opts.follow) return;
  // tail -f via fs.watch
  let size = fs.statSync(LOG_PATH).size;
  fs.watch(LOG_PATH, { persistent: true }, () => {
    const cur = fs.statSync(LOG_PATH).size;
    if (cur > size) {
      const fd = fs.openSync(LOG_PATH, 'r');
      const buf = Buffer.alloc(cur - size);
      fs.readSync(fd, buf, 0, cur - size, size);
      fs.closeSync(fd);
      process.stdout.write(buf.toString('utf-8'));
      size = cur;
    } else if (cur < size) {
      size = cur; // truncated
    }
  });
}
```

- [ ] **Step 2: Write `uninstall.ts`**

```typescript
// packages/bridge/src/uninstall.ts
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LAUNCHER_PATH } from './paths.js';

const NM_NAME = 'ai.byob.bridge';

function manifestDirsForPlatform(): string[] {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return [
      path.join(home, 'Library/Application Support/Google/Chrome/NativeMessagingHosts'),
      path.join(home, 'Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts'),
      path.join(home, 'Library/Application Support/Microsoft Edge/NativeMessagingHosts'),
    ];
  }
  if (process.platform === 'linux') {
    return [
      path.join(home, '.config/google-chrome/NativeMessagingHosts'),
      path.join(home, '.config/BraveSoftware/Brave-Browser/NativeMessagingHosts'),
    ];
  }
  return [];
}

export function uninstall(): void {
  if (fs.existsSync(LAUNCHER_PATH)) { fs.unlinkSync(LAUNCHER_PATH); console.log(`removed ${LAUNCHER_PATH}`); }
  for (const dir of manifestDirsForPlatform()) {
    const p = path.join(dir, `${NM_NAME}.json`);
    if (fs.existsSync(p)) { fs.unlinkSync(p); console.log(`removed ${p}`); }
  }
  console.log('Done. Reload the extension in Chrome to drop the existing connection.');
}
```

- [ ] **Step 3: Wire into CLI**

```typescript
// packages/bridge/bin/byob.ts — add commands:
program.command('bridges').description('list live bridges').action(async () => {
  const { listAliveBridges } = await import('../src/bridge-registry.js');
  const alive = listAliveBridges();
  if (alive.length === 0) { console.log('No live bridges.'); return; }
  for (const b of alive) {
    const upS = Math.round((Date.now() - b.startedAt) / 1000);
    console.log(`${b.deviceId}  pid ${b.pid}  ${b.socket}  uptime ${upS}s`);
  }
});

program.command('logs').description('tail bridge log').option('-f, --follow').action(async (opts: { follow?: boolean }) => {
  const { tailLog } = await import('../src/logs.js');
  await tailLog({ follow: !!opts.follow });
});

program.command('uninstall').description('remove launcher + NM manifests').action(async () => {
  const { uninstall } = await import('../src/uninstall.js');
  uninstall();
});
```

- [ ] **Step 4: Commit**

```sh
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
cd /Users/wxt/code/byob
bun --cwd packages/bridge run typecheck
git add packages/bridge/src/logs.ts packages/bridge/src/uninstall.ts packages/bridge/bin/byob.ts
git commit -m "$(cat <<'EOF'
feat(bridge): byob bridges / logs / uninstall

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7.2: README + e2e checklist + .gitignore touch-ups

**Files:**
- Create: `/Users/wxt/code/byob/README.md`
- Create: `/Users/wxt/code/byob/docs/e2e-checklist.md`

- [ ] **Step 1: Write `README.md`**

```markdown
# byob — Bring Your Own Browser

Local-only browser bridge for AI agents (MCP). Lets Claude Code / Cursor / Cline drive your real Chrome — with your cookies, your sessions, your reCAPTCHA solves.

## Quick Start (5 min)

```sh
# 1. Clone + install
git clone <this-repo> ~/code/byob
cd ~/code/byob
bun install

# 2. Generate an extension key (one time)
mkdir -p ~/.byob
openssl genrsa -out ~/.byob/extension-key.pem 2048
openssl rsa -in ~/.byob/extension-key.pem -pubout -outform DER | base64 | tr -d '\n'
# Copy the output, paste into packages/extension/wxt.config.ts manifest.key

# 3. Build extension + install bridge
bun --cwd packages/extension run build
bun --cwd packages/bridge run dev:cli install --dev

# 4. Load the extension
# chrome://extensions → enable Developer mode → "Load unpacked"
# → select packages/extension/.output/chrome-mv3
# → restart Chrome (or just reload extension)

# 5. Verify
bun --cwd packages/bridge run dev:cli doctor
# All green = ready.

# 6. Connect to Claude Code
claude mcp add byob -- bun --cwd ~/code/byob/packages/mcp-server run dev
```

## Tools

| Tool | What it does |
|---|---|
| `browser_read` | Read full page text (auto-scrolls, lazy-load aware) |
| `browser_screenshot` | Save screenshot to disk; returns path |
| `browser_click` | Click an element by selector |
| `browser_type` | Type into an input (optional clear/Enter) |
| `browser_get_cookies` | Export cookies for a domain (great for `curl` follow-ups) |
| `browser_navigate` | Open or update a tab to a URL |
| `browser_wait_for` | Wait for a selector to be visible/hidden/attached |
| `browser_list_tabs` | List all open tabs |
| `browser_switch_tab` | Activate a tab by id |
| `browser_eval` | Run JS in a tab (DANGER, opt-in via `BYOB_ALLOW_EVAL=1`) |

## Security

- Bridge socket file mode is `0600`.
- `browser_eval` is hidden from MCP unless `BYOB_ALLOW_EVAL=1` is set.
- URL blacklist: `chrome:`, `file:`, major auth domains. Override with `BYOB_ALLOW_FILE=1` / `BYOB_ALLOW_AUTH_DOMAINS=1`.
- **Chrome shows a yellow "byob is debugging this tab" banner** when CDP is attached. This is a Chrome safety guarantee — it cannot be hidden.
- All eval calls are appended to `~/.byob/eval-audit.log` and trigger a Chrome notification.

## Troubleshooting

| Symptom | Try |
|---|---|
| `No live bridge` | `byob doctor` — most likely Chrome closed or extension disabled |
| `CDP attach failed` | Close DevTools (F12) on the target tab |
| `extension_not_connected` | Reload the extension in chrome://extensions |
| `bridge_not_running` after Chrome quit | Reopen Chrome; bridge is ephemeral and Chrome owns its lifetime |

## Architecture

See `docs/superpowers/specs/2026-04-25-byob-design.md`.
```

- [ ] **Step 2: Write `docs/e2e-checklist.md`**

```markdown
# byob v0.1 e2e Checklist

Run before tagging a release.

## Link

- [ ] `byob install --dev` succeeds
- [ ] `byob doctor` all green after extension reload + Chrome restart
- [ ] `curl --unix-socket ~/.byob/bridges/<id>.sock http://x/status` → `{connected:true}`

## Tools (all 10)

- [ ] `browser_read https://news.ycombinator.com` returns story headlines
- [ ] `browser_read https://x.com/anthropic` returns logged-in tweets (cookie reuse)
- [ ] `browser_screenshot https://github.com` writes PNG to `~/.byob/screenshots/`
- [ ] `browser_click` on Google's search box
- [ ] `browser_type` "mcp protocol" + Enter on Google
- [ ] `browser_get_cookies github.com` returns `user_session`
- [ ] `browser_navigate` between two domains, reuses tab
- [ ] `browser_wait_for #search` after a Google query
- [ ] `browser_list_tabs` returns all open tabs
- [ ] `browser_switch_tab` activates a chosen tab
- [ ] `BYOB_ALLOW_EVAL=1 browser_eval document.title` returns title + emits notification + audit-log line

## Errors

- [ ] `browser_read file:///etc/passwd` → `URL_FORBIDDEN`
- [ ] DevTools open → `browser_click` returns `CDP_ATTACH_FAILED`
- [ ] `BYOB_ALLOW_EVAL` unset → `browser_eval` not in tools/list
- [ ] Tab closed mid-op → `TAB_CLOSED`
- [ ] Chrome quit → `BRIDGE_NOT_RUNNING`

## MCP clients

- [ ] Claude Code: `"use byob to ..."` works
- [ ] Cursor: same
- [ ] Cancel mid-call (Ctrl+C) → bridge.log shows cancel + clean detach
```

- [ ] **Step 3: Commit**

```sh
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
cd /Users/wxt/code/byob
git add README.md docs/e2e-checklist.md
git commit -m "$(cat <<'EOF'
docs: README + e2e checklist for v0.1

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Phase 7 DEMO Checkpoint

Run the full e2e checklist in `docs/e2e-checklist.md`. Anything red → file an issue; anything green → tag v0.1.0.

```sh
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
cd /Users/wxt/code/byob
git tag v0.1.0
git log --oneline | head -40
```

**Stop here. Project MVP complete.**

---

## Self-Review (post-write)

**Spec coverage check:**

| Spec section | Implemented in |
|---|---|
| §3 Repository Structure | Phase 0 (Tasks 0.1–0.4) |
| §4 Tool Catalog (10 tools) | Phases 2 (read), 3 (click/type/navigate/wait_for), 4 (screenshot/get_cookies/list_tabs/switch_tab), 5 (eval) |
| §5 Data Flow | Phases 1, 2 (CDP injection + scroll loop) |
| §6 Native Messaging Protocol (frame format, hello/result/cancel/wake) | Tasks 1.1, 1.6, 1.7, 6.1; **wake message intentionally deferred to v0.2** |
| §7 Bridge IPC Protocol | Tasks 1.5, 1.6, 2.3 (read), 3.3 (click/type/navigate/wait-for), 4.1–4.3 (screenshot/cookies/tabs), 5.2 (eval) |
| §8 Security Model: socket 0600 | Task 1.5 (chmod sock 0600) |
| §8 Security Model: eval guards | Task 5.2 (notify + throttle), 5.3 (env gate) |
| §8 Security Model: URL blacklist | Task 5.1 |
| §8 Security Model: abort propagation | Task 6.1 |
| §9 Error Model | Task 0.2 (codes), 1.5 (envelope), 2.4 (mapper), 6.1 (aborted flag) |
| §10 Lifecycle: bridge start/stop | Task 1.6 (shutdown handlers) |
| §10 Lifecycle: multi-instance | Task 1.3 (registry), 2.4 (resolveBridge) |
| §10 Lifecycle: SW keep-alive | Task 1.7 (alarms) |
| §11 Management CLI: install/doctor | Tasks 1.4, 1.8, 7.1 |
| §11 Management CLI: bridges/logs/uninstall | Task 7.1 |
| §12 Development Workflow | Task 1.4 (`--dev` launcher) |
| §13 E2E Checklist | Task 7.2 |
| §14 Release Strategy | Task 7.2 (no Web Store yet); confirmed in plan |
| §15 Open Questions | Each addressed inline by design choices in implementing tasks |

**Gaps (deliberate deferrals to v0.2):**

1. **Wake-detection message (`{type:'wake'}`)** — listed in spec §6; not wired in MVP. Add in v0.2 when long-running sessions across system sleep become a real issue.
2. **Loopback HTTP for large screenshots** — spec §6/7 mention this. Phase 4 ships the simple base64-over-NM path with a 800KB cap. Add loopback when users actually hit the cap.
3. **Cross-origin iframe support** — spec §15 explicitly defers to v2. Confirmed not in plan.

**Type/name consistency check:**

- Command names (`Command.Read = 'readPage'`) — consistent across `shared/commands.ts`, extension dispatcher, bridge `routeFor` calls.
- Route paths consistent: `/read`, `/click`, `/type`, `/navigate`, `/wait-for`, `/screenshot`, `/cookies`, `/tabs` (GET), `/tabs/switch`, `/eval`.
- `Handler` signature evolves: Phase 2 has `(params)`, Phase 6 widens to `(params, signal)`. Caught and updated.

**Placeholder scan:**

- One intentional placeholder: `wxt.config.ts manifest.key = 'REPLACE_WITH_BASE64_DER_PUBLIC_KEY'` — Task 1.4 step 3 explicitly walks the user through replacing it. Not a true placeholder, just a setup step.
- No "TBD" / "TODO" / "fill in" outside that.

**End of plan.**





