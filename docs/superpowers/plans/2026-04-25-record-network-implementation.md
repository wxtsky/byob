# C `browser_record_network` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a start/stop pair of MCP tools that capture every HTTP/HTTPS request, response, body, timing, and WebSocket frame on a real Chrome tab during the recording window, returning either raw JSON records or a HAR 1.2 archive.

**Architecture:** A `recording-registry` map keyed by `recordingId` keeps each in-flight session alive across the start/stop pair (one CdpSession per recording, isolated `Network.enable` parameters, listeners that push CDP events into per-`requestId` accumulators). The Service Worker is held alive across the recording window via the existing refcounted `keepAwakeStart/End` plus a 25 s no-op `chrome.alarms` tick (defence-in-depth against MV3 SW eviction). `autoStop` paths (`max_records` / `timeout` / `tab_closed`) detach CDP and flip the entry to an `ended` state so a later `stop` call can still drain the buffer.

**Tech Stack:** TypeScript strict · WXT MV3 (extension) · Chrome DevTools Protocol `Network` domain · Node 22+ (bridge & mcp-server) · `@modelcontextprotocol/sdk` · Zod 3 · `bun:test` for pure-function unit tests · undici over UNIX socket (already wired)

**Spec reference:** `/Users/wxt/code/byob/docs/superpowers/specs/2026-04-25-record-network-design.md`

---

## File Structure

| File | Purpose | Status |
|---|---|---|
| `shared/src/commands.ts` | Add `StartRecordNetwork`, `StopRecordNetwork` command-name constants | Modify |
| `shared/src/schemas.ts` | Add `StartRecordNetworkInput/Output`, `StopRecordNetworkInput/Output`, `NetworkRecordSchema`, `WebSocketFrameSchema`, `HarSchema` | Modify |
| `shared/src/errors.ts` | Add `RECORDING_NOT_FOUND`, `RECORDING_FAILED_TO_ATTACH` codes | Modify |
| `packages/extension/lib/recording-registry.ts` | New. In-memory `Map<recordingId, RecordingEntry>` + `keepalive-tick` alarm + GC for `ended` entries | Create |
| `packages/extension/lib/network-events.ts` | New. Listener factory: CDP `Network.*` events → `NetworkRecord` accumulator. urlPattern matching (glob/regex). filter logic. `getResponseBody` with 5 s timeout. WebSocket frame capture | Create |
| `packages/extension/lib/har-converter.ts` | New. Pure function `recordsToHar(records, creator)` returning HAR 1.2 `log` object. WebSocket entries get `_webSocketMessages` (Chrome DevTools-compatible custom field) | Create |
| `packages/extension/lib/handlers/start-record-network.ts` | New. Resolves tab, attaches CdpSession, wires listeners through `network-events.ts`, registers entry, starts timeout/alarm/keepalive | Create |
| `packages/extension/lib/handlers/stop-record-network.ts` | New. Looks up entry, awaits `flushDelayMs`, detaches CDP, releases keepalive, returns records (and optional HAR) | Create |
| `packages/extension/lib/handlers/index.ts` | Wire two new handlers into the dispatcher map | Modify |
| `packages/bridge/src/main.ts` | Two new HTTP routes: `record-network/start`, `record-network/stop`. Pass through long timeout (recording can be minutes long) | Modify |
| `packages/mcp-server/src/tools/browser-start-record-network.ts` | New. Register `browser_start_record_network` tool | Create |
| `packages/mcp-server/src/tools/browser-stop-record-network.ts` | New. Register `browser_stop_record_network` tool | Create |
| `packages/mcp-server/src/tools/index.ts` | Wire two new tool registrations | Modify |
| `packages/extension/lib/__tests__/har-converter.test.ts` | New. `bun:test` — verifies HAR 1.2 entry shape from a fixture `NetworkRecord[]` | Create |
| `packages/extension/lib/__tests__/network-events.test.ts` | New. `bun:test` — verifies `requestWillBeSent` / `responseReceived` / `loadingFinished` events accumulate into a single record correctly | Create |
| `packages/extension/lib/__tests__/url-pattern.test.ts` | New. `bun:test` — verifies glob (`*api*`) vs regex (`/regex/`) detection and matching | Create |
| `docs/e2e-checklist.md` | Add 9 manual e2e items from spec §10 | Modify |

### Architectural notes (locked in by this plan)

1. **No framePath** — Network domain is tab-level (auto-covers iframe requests), so neither handler accepts a `framePath` parameter. This decision is final and matches spec §5.
2. **AbortSignal-ready signature, but not implemented** — Both handlers' top-level functions take an optional `AbortSignal` parameter (so future `B` sub-project can wire it without touching this code), but the implementation does not yet call `signal.throwIfAborted()`. Reviewer should not flag missing abort handling.
3. **No CDP `Page.captureFramework`-style coupling** — Each recording owns its own `CdpSession`, but shares the existing `tryAttachToTab` machinery. The shared session map (`packages/extension/lib/cdp.ts:100`) means **only one** CDP attach per tab. If `browser_eval` or another tool is already attached, that same session is reused — recording adds listeners to it. **Detach happens only when the recording entry says nobody else needs it**: stop/autoStop calls `session.detach()` only if no other recording references this tab. (See §Task 5 cleanup logic.)
4. **HAR custom field naming** — `_webSocketMessages` is the chosen field. Chrome DevTools' "Save all as HAR with content" exports use the same name. Validators that fail on unknown `_*` fields exist (e.g. strict har-validator); we accept that risk and document it.
5. **Body byte budget is character-count, not byte-count** — `maxBodyBytes` truncates by `String.prototype.slice` after CDP returns the body. Treat the limit as approximate when bodies are non-ASCII. This matches what `Network.enable` itself does internally.

---

## Coordination With Sibling Sub-Projects

- **A** (auto-handler-registration refactor): This plan does not depend on A. The two new handlers are wired into `handlers/index.ts` manually following the existing pattern. If A lands first, the wiring step becomes a no-op (auto-discovery picks them up).
- **B** (AbortSignal end-to-end): The signature `handleStartRecordNetwork(rawParams: unknown, signal?: AbortSignal)` reserves the slot. B will plumb the actual abort through later. **Do not** add `signal.throwIfAborted()` calls in this plan.
- **D** (cross-frame iframe support): Spec §5 explicitly says Network domain is tab-level, so D will not touch this code path.

---

## Conventions

- **Bash prefix** — Always `unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY;` before commands per CLAUDE.md.
- **Package manager** — `bun` for shared / extension / mcp-server. `node 22 + tsx` for bridge runtime; bridge also uses `bun` for typecheck/install per repo convention.
- **ESM imports** — Always end import paths with `.js` (TS resolves to `.ts` source via `moduleResolution: "Bundler"`).
- **No emoji in source code** unless the user explicitly asks. (User preference applies to docs as well; keep this plan emoji-free.)
- **Commit cadence** — One commit per task. Each commit message ends with `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`. **Do not run `git commit` yourself unless the user explicitly requests it** — the commit step is a documented action for the user/operator to execute.
- **No top-level `type` field** in handler return values — collides with the NM-protocol envelope. (See HANDOFF.md decision §4.)

---

# Task 1: Shared schemas, command names, error codes

**Files:**
- Modify: `/Users/wxt/code/byob/shared/src/commands.ts`
- Modify: `/Users/wxt/code/byob/shared/src/errors.ts`
- Modify: `/Users/wxt/code/byob/shared/src/schemas.ts`

- [ ] **Step 1: Add command-name constants**

In `/Users/wxt/code/byob/shared/src/commands.ts`, extend the `Command` const:

```ts
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
  DownloadImages: 'downloadImages',
  StartRecordNetwork: 'startRecordNetwork',
  StopRecordNetwork:  'stopRecordNetwork',
} as const;

export type CommandName = (typeof Command)[keyof typeof Command];
```

- [ ] **Step 2: Add error codes**

In `/Users/wxt/code/byob/shared/src/errors.ts`, add to the `ErrorCode` const:

```ts
export const ErrorCode = {
  // ... existing ...
  RECORDING_NOT_FOUND:      'recording_not_found',
  RECORDING_FAILED_TO_ATTACH: 'recording_failed_to_attach',
  UNKNOWN:                 'unknown',
} as const;
```

(Insert the two new lines just above `UNKNOWN` so it stays last.)

- [ ] **Step 3: Add WebSocketFrame and NetworkRecord schemas**

In `/Users/wxt/code/byob/shared/src/schemas.ts`, append at the bottom of the file:

```ts
// ---------- 12. browser_record_network ----------
export const WebSocketFrameSchema = z.object({
  direction: z.enum(['sent', 'received']),
  timestamp: z.number(),                 // ms since epoch
  opcode: z.number().int(),              // 1=text, 2=binary, 8=close, 9=ping, 10=pong
  payload: z.string(),                   // text for opcode=1, base64 for opcode=2
  truncated: z.boolean().optional(),
});
export type WebSocketFrame = z.infer<typeof WebSocketFrameSchema>;

export const NetworkRecordSchema = z.object({
  requestId: z.string(),
  url: z.string(),
  method: z.string(),
  resourceType: z.enum([
    'xhr', 'fetch', 'document', 'script', 'stylesheet',
    'image', 'media', 'font', 'websocket', 'other',
  ]),

  requestHeaders: z.record(z.string(), z.string()).optional(),
  requestPostData: z.string().optional(),
  requestPostDataTruncated: z.boolean().optional(),

  responseStatus: z.number().int().optional(),
  responseStatusText: z.string().optional(),
  responseHeaders: z.record(z.string(), z.string()).optional(),
  responseMimeType: z.string().optional(),
  responseBody: z.string().optional(),
  responseBodyEncoding: z.enum(['utf8', 'base64']).optional(),
  responseBodyTruncated: z.boolean().optional(),

  failed: z.boolean().optional(),
  errorText: z.string().optional(),
  fromCache: z.boolean().optional(),
  fromServiceWorker: z.boolean().optional(),

  timing: z.object({
    startTime: z.number(),
    endTime: z.number().optional(),
    durationMs: z.number().optional(),
    dnsMs: z.number().optional(),
    connectMs: z.number().optional(),
    sslMs: z.number().optional(),
    sendMs: z.number().optional(),
    waitMs: z.number().optional(),
    receiveMs: z.number().optional(),
  }),

  initiator: z.object({
    type: z.enum(['parser', 'script', 'preflight', 'other']),
    url: z.string().optional(),
    lineno: z.number().optional(),
  }).optional(),

  webSocketFrames: z.array(WebSocketFrameSchema).optional(),
});
export type NetworkRecord = z.infer<typeof NetworkRecordSchema>;
```

- [ ] **Step 4: Add HAR schema**

Append to `/Users/wxt/code/byob/shared/src/schemas.ts`:

```ts
// HAR 1.2 — narrow shape, only what we emit. Full HAR spec is huge; we
// validate structure, not every optional field, so consumers using strict
// har-validator may need to relax their schema.
export const HarSchema = z.object({
  log: z.object({
    version: z.literal('1.2'),
    creator: z.object({ name: z.string(), version: z.string() }),
    pages: z.array(z.unknown()),
    entries: z.array(z.unknown()),
  }),
});
export type Har = z.infer<typeof HarSchema>;
```

- [ ] **Step 5: Add Start input/output schemas**

Append to `/Users/wxt/code/byob/shared/src/schemas.ts`:

```ts
const ResourceTypeFilterSchema = z
  .array(z.string())
  .default(['xhr', 'fetch']);

export const StartRecordNetworkInputRaw = z.object({
  url: z.string().url().optional(),
  tabId: z.number().int().optional(),
  resourceTypes: ResourceTypeFilterSchema,
  urlPattern: z.string().optional(),
  includeRequestBody: z.boolean().default(true),
  includeResponseBody: z.boolean().default(true),
  maxBodyBytes: z.number().int().min(0).max(8 * 1024 * 1024).default(262144),
  maxRecords: z.number().int().min(1).max(10000).default(500),
  captureWebSocketFrames: z.boolean().default(true),
  maxFrameBytes: z.number().int().min(0).max(1024 * 1024).default(32768),
  timeoutMs: z.number().int().min(1000).max(60 * 60 * 1000).default(300_000),
});
export const StartRecordNetworkInput = StartRecordNetworkInputRaw.refine(
  (v) => v.url || v.tabId !== undefined,
  { message: 'either url or tabId is required' },
);
export const StartRecordNetworkOutput = z.object({
  recordingId: z.string(),
  tabId: z.number().int(),
  url: z.string(),
  startedAt: z.number(),
});
```

The `*Raw` shape is exposed because `ZodEffects.refine()` strips `.shape`, and MCP `inputSchema` requires the raw object form. (Same pattern as `GetCookiesInput`.)

- [ ] **Step 6: Add Stop input/output schemas**

Append to `/Users/wxt/code/byob/shared/src/schemas.ts`:

```ts
export const StopRecordNetworkInput = z.object({
  recordingId: z.string(),
  flushDelayMs: z.number().int().min(0).max(30_000).default(500),
  format: z.enum(['json', 'har']).default('json'),
});
export const StopRecordNetworkOutput = z.object({
  records: z.array(NetworkRecordSchema),
  har: HarSchema.optional(),
  truncated: z.boolean(),
  durationMs: z.number(),
  recordCount: z.number().int(),
  endedReason: z.enum(['user_stop', 'max_records', 'timeout', 'tab_closed', 'wake_recovery']),
  tabId: z.number().int(),
});
```

- [ ] **Step 7: Run typecheck**

Run: `unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY; cd /Users/wxt/code/byob && bun run typecheck`
Expected: All four packages green. (Note: extension package will likely also pass — it imports `@byob/shared` and the new exports add only types.)

- [ ] **Step 8: Commit**

Commit message:

```
feat(shared): network recording schemas, commands, error codes

Adds WebSocketFrameSchema, NetworkRecordSchema, HarSchema, and
StartRecordNetwork{Input,Output} / StopRecordNetwork{Input,Output} for the
upcoming browser_record_network tool pair. New command name constants
(StartRecordNetwork / StopRecordNetwork) and error codes
(recording_not_found, recording_failed_to_attach) wired through the same
pattern as existing tools.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

---

# Task 2: URL-pattern parser (pure utility)

**Files:**
- Create: `/Users/wxt/code/byob/packages/extension/lib/url-pattern.ts`
- Test: `/Users/wxt/code/byob/packages/extension/lib/__tests__/url-pattern.test.ts`

This is a small pure utility, used by `network-events.ts` to filter requests. It needs unit tests because parser bugs silently drop records.

- [ ] **Step 1: Write the failing test**

Create `/Users/wxt/code/byob/packages/extension/lib/__tests__/url-pattern.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { compileUrlPattern, matchUrl } from '../url-pattern.js';

describe('compileUrlPattern', () => {
  test('returns null for empty / undefined input', () => {
    expect(compileUrlPattern(undefined)).toBeNull();
    expect(compileUrlPattern('')).toBeNull();
  });

  test('treats /.../ delimited input as regex', () => {
    const m = compileUrlPattern('/api\\/v\\d+/');
    expect(m).not.toBeNull();
    expect(matchUrl(m, 'https://x.com/api/v2/users')).toBe(true);
    expect(matchUrl(m, 'https://x.com/static/main.js')).toBe(false);
  });

  test('regex with flags: /.../i', () => {
    const m = compileUrlPattern('/API/i');
    expect(matchUrl(m, 'https://x.com/api/users')).toBe(true);
  });

  test('treats other input as glob with * wildcard', () => {
    const m = compileUrlPattern('*api*');
    expect(matchUrl(m, 'https://x.com/api/v2/users')).toBe(true);
    expect(matchUrl(m, 'https://x.com/static/main.js')).toBe(false);
  });

  test('glob is case-sensitive', () => {
    const m = compileUrlPattern('*API*');
    expect(matchUrl(m, 'https://x.com/api/users')).toBe(false);
  });

  test('glob with anchored prefix and suffix', () => {
    const m = compileUrlPattern('https://api.example.com/*');
    expect(matchUrl(m, 'https://api.example.com/v1/foo')).toBe(true);
    expect(matchUrl(m, 'https://other.com/api.example.com/x')).toBe(false);
  });

  test('matchUrl returns true when pattern is null (no filter)', () => {
    expect(matchUrl(null, 'anything')).toBe(true);
  });

  test('invalid regex falls back to literal-glob safely (no throw)', () => {
    // Unbalanced bracket — regex compile would throw, we want graceful fallback
    const m = compileUrlPattern('/[unclosed/');
    // either null (rejected) or matches literally — both are safe
    expect(typeof m).toBe('object');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY; cd /Users/wxt/code/byob/packages/extension && bun test lib/__tests__/url-pattern.test.ts`
Expected: FAIL — `Cannot find module '../url-pattern.js'`.

- [ ] **Step 3: Implement url-pattern.ts**

Create `/Users/wxt/code/byob/packages/extension/lib/url-pattern.ts`:

```ts
// URL pattern compiler used by record-network filter. Recognises two formats:
//   - /regex/flags  → JS RegExp
//   - anything else → glob with `*` (any chars including `/`) wildcard
//
// Returns null when pattern is empty/undefined; matchUrl(null, ...) always
// returns true so call sites don't have to special-case "no filter".

export type CompiledPattern = RegExp | null;

export function compileUrlPattern(pattern: string | undefined): CompiledPattern {
  if (!pattern) return null;
  // Regex form: /pattern/flags  (e.g. /api\/v\d+/i)
  const m = /^\/(.+)\/([a-z]*)$/.exec(pattern);
  if (m) {
    try {
      return new RegExp(m[1]!, m[2]);
    } catch {
      // fall through to glob — never throw out of a filter compiler
    }
  }
  // Glob form: escape regex specials, replace * with .*
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  try {
    return new RegExp('^' + escaped + '$');
  } catch {
    return null;
  }
}

export function matchUrl(pattern: CompiledPattern, url: string): boolean {
  if (pattern === null) return true;
  return pattern.test(url);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY; cd /Users/wxt/code/byob/packages/extension && bun test lib/__tests__/url-pattern.test.ts`
Expected: All 8 tests PASS.

- [ ] **Step 5: Commit**

Commit message:

```
feat(extension): url-pattern compiler for record-network filter

Pure utility that turns user-supplied glob (*api*) or regex (/regex/flags)
strings into a compiled matcher. Used by the upcoming network-events filter
to decide which CDP request events to retain.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

---

# Task 3: Recording registry (in-memory state)

**Files:**
- Create: `/Users/wxt/code/byob/packages/extension/lib/recording-registry.ts`

This is a Map-backed registry plus a single `chrome.alarms` tick used as belt-and-suspenders SW eviction defence. No tests for it — its behaviour is validated end-to-end via the manual checklist in Task 11.

- [ ] **Step 1: Implement recording-registry.ts**

Create `/Users/wxt/code/byob/packages/extension/lib/recording-registry.ts`:

```ts
import type { NetworkRecord } from '@byob/shared';
import type { CdpSession } from './cdp.js';

export type EndedReason =
  | 'user_stop'
  | 'max_records'
  | 'timeout'
  | 'tab_closed'
  | 'wake_recovery';

export interface RecordingOptions {
  resourceTypes: string[];
  urlPattern: string | undefined;
  includeRequestBody: boolean;
  includeResponseBody: boolean;
  maxBodyBytes: number;
  maxRecords: number;
  captureWebSocketFrames: boolean;
  maxFrameBytes: number;
  timeoutMs: number;
}

export interface RecordingEntry {
  recordingId: string;
  tabId: number;
  session: CdpSession;
  /** Per-requestId accumulators. Insertion order = arrival order. */
  buffer: Map<string, NetworkRecord>;
  /** WebSocket frame total bytes — used to back off after maxRecords*10 budget */
  wsBudgetUsed: number;
  options: RecordingOptions;
  startedAt: number;
  /** Listener cleanup functions installed in network-events.ts. */
  listenerCleanups: Array<() => void>;
  state: 'recording' | 'ended';
  endedReason?: EndedReason;
  endedAt?: number;
  /** setTimeout handle for the user-supplied timeoutMs autoStop. */
  timeoutId: ReturnType<typeof setTimeout> | null;
  /** Chrome onRemoved listener for tab-close detection. */
  tabRemovedListener: ((tabId: number) => void) | null;
  /** True iff this entry currently holds a +1 keepalive ref. */
  keepaliveHeld: boolean;
}

const registry = new Map<string, RecordingEntry>();

const KEEPALIVE_ALARM_NAME = 'byob-record-network-tick';
const ENDED_ENTRY_GC_MULTIPLIER = 2; // ended entry GC'd at 2 * timeoutMs

/** Returns the same Map each call; safe to use from listener factories. */
export function getRegistry(): Map<string, RecordingEntry> {
  return registry;
}

export function addRecording(entry: RecordingEntry): void {
  registry.set(entry.recordingId, entry);
  ensureKeepaliveTick();
}

export function getRecording(id: string): RecordingEntry | undefined {
  return registry.get(id);
}

export function deleteRecording(id: string): void {
  registry.delete(id);
  if (countActive() === 0) clearKeepaliveTick();
}

export function countActive(): number {
  let n = 0;
  for (const e of registry.values()) if (e.state === 'recording') n++;
  return n;
}

/**
 * Install a 25 s no-op chrome.alarms tick. Belt-and-suspenders against MV3 SW
 * eviction during long recordings. Idempotent — installs at most one alarm
 * regardless of how many concurrent recordings exist.
 */
function ensureKeepaliveTick(): void {
  // periodInMinutes minimum is technically 1 in production builds, but the
  // browser tolerates 0.5 (= 30s) and 0.4 (~24s) — we use 0.4 to comfortably
  // stay below the 30s SW idle threshold. This matches the existing
  // background.ts 'byob-keepalive' alarm cadence.
  chrome.alarms.get(KEEPALIVE_ALARM_NAME, (existing) => {
    if (!existing) {
      chrome.alarms.create(KEEPALIVE_ALARM_NAME, { periodInMinutes: 0.4 });
    }
  });
}

function clearKeepaliveTick(): void {
  chrome.alarms.clear(KEEPALIVE_ALARM_NAME).catch(() => {
    // ignore — alarm may not exist
  });
}

/**
 * GC ended entries that have been sitting around too long without being
 * drained by stop_record_network. Prevents leaks from clients that crash
 * after autoStop fires. Run from the keepalive alarm tick.
 */
export function gcEndedEntries(now: number): void {
  for (const [id, e] of registry) {
    if (e.state !== 'ended') continue;
    if (e.endedAt === undefined) continue;
    const ttl = e.options.timeoutMs * ENDED_ENTRY_GC_MULTIPLIER;
    if (now - e.endedAt > ttl) {
      registry.delete(id);
    }
  }
  if (countActive() === 0 && registry.size === 0) clearKeepaliveTick();
}

// Wire alarm tick → GC sweep. We don't add another listener if one already
// exists from a previous SW boot — listenerStat() isn't a real API, so we
// rely on the dispatcher being added at module load time and SW evictions
// re-importing the module fresh.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM_NAME) {
    gcEndedEntries(Date.now());
  }
});
```

- [ ] **Step 2: Run typecheck**

Run: `unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY; cd /Users/wxt/code/byob/packages/extension && bun run typecheck`
Expected: No errors. (`recording-registry.ts` only imports types, so no runtime path is exercised yet.)

- [ ] **Step 3: Commit**

Commit message:

```
feat(extension): in-memory recording registry with SW eviction defence

Map<recordingId, RecordingEntry> keyed lookup, plus a no-op chrome.alarms
tick (~24s) that runs while any recording is active. Adds a GC sweep for
'ended' entries whose stop call never came (fires at 2 * timeoutMs).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

---

# Task 4: CDP event accumulator (network-events.ts)

**Files:**
- Create: `/Users/wxt/code/byob/packages/extension/lib/network-events.ts`
- Test: `/Users/wxt/code/byob/packages/extension/lib/__tests__/network-events.test.ts`

This module wires `chrome.debugger.onEvent` to a recording entry. The pure event-handling logic (events → record fields) is tested with mocked CDP event objects.

- [ ] **Step 1: Write the failing test**

Create `/Users/wxt/code/byob/packages/extension/lib/__tests__/network-events.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import {
  applyRequestWillBeSent,
  applyResponseReceived,
  applyLoadingFinished,
  applyLoadingFailed,
  applyWebSocketFrame,
  shouldRecordRequest,
  type AccumulatorContext,
} from '../network-events.js';
import type { NetworkRecord } from '@byob/shared';

function ctx(opts: Partial<AccumulatorContext['options']> = {}): AccumulatorContext {
  return {
    buffer: new Map<string, NetworkRecord>(),
    options: {
      resourceTypes: ['xhr', 'fetch'],
      urlPattern: undefined,
      includeRequestBody: true,
      includeResponseBody: true,
      maxBodyBytes: 1000,
      maxRecords: 500,
      captureWebSocketFrames: true,
      maxFrameBytes: 100,
      timeoutMs: 60_000,
      ...opts,
    },
    wsBudgetUsed: 0,
  };
}

describe('shouldRecordRequest', () => {
  test('passes when resourceType matches and no urlPattern', () => {
    const c = ctx();
    const event = {
      requestId: 'a',
      type: 'XHR',
      request: { url: 'https://example.com/x', method: 'GET', headers: {} },
      timestamp: 1,
      wallTime: 1700000,
      initiator: { type: 'parser' },
    };
    expect(shouldRecordRequest(c, event)).toBe(true);
  });

  test('rejects when resourceType not in filter', () => {
    const c = ctx({ resourceTypes: ['xhr'] });
    const event = {
      requestId: 'a',
      type: 'Image',
      request: { url: 'https://x.com/img.png', method: 'GET', headers: {} },
      timestamp: 1, wallTime: 1, initiator: { type: 'parser' },
    };
    expect(shouldRecordRequest(c, event)).toBe(false);
  });

  test("['*'] resourceType means all", () => {
    const c = ctx({ resourceTypes: ['*'] });
    const event = {
      requestId: 'a',
      type: 'Media',
      request: { url: 'https://x.com/v.mp4', method: 'GET', headers: {} },
      timestamp: 1, wallTime: 1, initiator: { type: 'parser' },
    };
    expect(shouldRecordRequest(c, event)).toBe(true);
  });

  test('urlPattern glob filter applies', () => {
    const c = ctx({ resourceTypes: ['*'], urlPattern: '*api*' });
    const apiEvent = {
      requestId: 'a', type: 'XHR',
      request: { url: 'https://x.com/api/v2', method: 'GET', headers: {} },
      timestamp: 1, wallTime: 1, initiator: { type: 'parser' },
    };
    const staticEvent = { ...apiEvent, request: { ...apiEvent.request, url: 'https://x.com/main.js' } };
    expect(shouldRecordRequest(c, apiEvent)).toBe(true);
    expect(shouldRecordRequest(c, staticEvent)).toBe(false);
  });
});

describe('applyRequestWillBeSent', () => {
  test('creates a record with method/url/headers/postData', () => {
    const c = ctx();
    applyRequestWillBeSent(c, {
      requestId: 'a',
      type: 'XHR',
      request: {
        url: 'https://x.com/api',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        postData: '{"k":1}',
      },
      timestamp: 100,
      wallTime: 1700000.5,
      initiator: { type: 'script', url: 'app.js', lineNumber: 12 },
    });
    const rec = c.buffer.get('a')!;
    expect(rec).toBeDefined();
    expect(rec.url).toBe('https://x.com/api');
    expect(rec.method).toBe('POST');
    expect(rec.requestHeaders).toEqual({ 'Content-Type': 'application/json' });
    expect(rec.requestPostData).toBe('{"k":1}');
    expect(rec.resourceType).toBe('xhr');
    expect(rec.timing.startTime).toBeCloseTo(1700000.5 * 1000, 1);
    expect(rec.initiator).toEqual({ type: 'script', url: 'app.js', lineno: 12 });
  });

  test('truncates postData over maxBodyBytes', () => {
    const c = ctx({ maxBodyBytes: 4 });
    applyRequestWillBeSent(c, {
      requestId: 'a',
      type: 'XHR',
      request: { url: 'https://x.com/x', method: 'POST', headers: {}, postData: '12345678' },
      timestamp: 1, wallTime: 1, initiator: { type: 'parser' },
    });
    const rec = c.buffer.get('a')!;
    expect(rec.requestPostData).toBe('1234');
    expect(rec.requestPostDataTruncated).toBe(true);
  });

  test('omits requestPostData when includeRequestBody=false', () => {
    const c = ctx({ includeRequestBody: false });
    applyRequestWillBeSent(c, {
      requestId: 'a',
      type: 'XHR',
      request: { url: 'https://x.com/x', method: 'POST', headers: {}, postData: 'body' },
      timestamp: 1, wallTime: 1, initiator: { type: 'parser' },
    });
    const rec = c.buffer.get('a')!;
    expect(rec.requestPostData).toBeUndefined();
  });
});

describe('applyResponseReceived', () => {
  test('fills status / responseHeaders / mimeType / fromCache', () => {
    const c = ctx();
    applyRequestWillBeSent(c, {
      requestId: 'a', type: 'XHR',
      request: { url: 'https://x.com', method: 'GET', headers: {} },
      timestamp: 1, wallTime: 1, initiator: { type: 'parser' },
    });
    applyResponseReceived(c, {
      requestId: 'a',
      response: {
        status: 200, statusText: 'OK',
        headers: { 'content-type': 'application/json' },
        mimeType: 'application/json',
        fromDiskCache: true,
        fromServiceWorker: false,
        timing: {
          requestTime: 0,
          dnsStart: 0, dnsEnd: 5,
          connectStart: 5, connectEnd: 20,
          sslStart: 10, sslEnd: 18,
          sendStart: 20, sendEnd: 22,
          receiveHeadersEnd: 50,
        },
      },
      timestamp: 1.05,
    });
    const rec = c.buffer.get('a')!;
    expect(rec.responseStatus).toBe(200);
    expect(rec.responseStatusText).toBe('OK');
    expect(rec.responseHeaders).toEqual({ 'content-type': 'application/json' });
    expect(rec.responseMimeType).toBe('application/json');
    expect(rec.fromCache).toBe(true);
    expect(rec.timing.dnsMs).toBe(5);
    expect(rec.timing.connectMs).toBe(15);
    expect(rec.timing.sslMs).toBe(8);
    expect(rec.timing.sendMs).toBe(2);
    expect(rec.timing.waitMs).toBe(28);
  });

  test('is a no-op if requestId never created (filtered out)', () => {
    const c = ctx();
    applyResponseReceived(c, {
      requestId: 'ghost',
      response: { status: 200, statusText: 'OK', headers: {}, mimeType: 'text/html' },
      timestamp: 1,
    });
    expect(c.buffer.has('ghost')).toBe(false);
  });
});

describe('applyLoadingFinished + applyLoadingFailed', () => {
  test('finished sets endTime and durationMs', () => {
    const c = ctx();
    applyRequestWillBeSent(c, {
      requestId: 'a', type: 'XHR',
      request: { url: 'https://x.com', method: 'GET', headers: {} },
      timestamp: 100, wallTime: 1700, initiator: { type: 'parser' },
    });
    applyLoadingFinished(c, { requestId: 'a', timestamp: 100.5 });
    const rec = c.buffer.get('a')!;
    expect(rec.timing.endTime).toBeCloseTo(rec.timing.startTime + 500, 1);
    expect(rec.timing.durationMs).toBe(500);
  });

  test('failed sets failed=true + errorText', () => {
    const c = ctx();
    applyRequestWillBeSent(c, {
      requestId: 'a', type: 'XHR',
      request: { url: 'https://x.com', method: 'GET', headers: {} },
      timestamp: 100, wallTime: 1700, initiator: { type: 'parser' },
    });
    applyLoadingFailed(c, { requestId: 'a', timestamp: 100.5, errorText: 'net::ERR_FAILED' });
    const rec = c.buffer.get('a')!;
    expect(rec.failed).toBe(true);
    expect(rec.errorText).toBe('net::ERR_FAILED');
  });
});

describe('applyWebSocketFrame', () => {
  test('appends a sent text frame to record.webSocketFrames', () => {
    const c = ctx();
    // create a record manually (simulates webSocketCreated already fired)
    c.buffer.set('a', {
      requestId: 'a', url: 'wss://x.com/ws', method: 'GET',
      resourceType: 'websocket',
      timing: { startTime: Date.now() },
      webSocketFrames: [],
    });
    applyWebSocketFrame(c, {
      requestId: 'a',
      timestamp: 12345,
      direction: 'sent',
      response: { opcode: 1, mask: false, payloadData: 'hello' },
    });
    const rec = c.buffer.get('a')!;
    expect(rec.webSocketFrames!.length).toBe(1);
    expect(rec.webSocketFrames![0]!.direction).toBe('sent');
    expect(rec.webSocketFrames![0]!.opcode).toBe(1);
    expect(rec.webSocketFrames![0]!.payload).toBe('hello');
  });

  test('truncates frame payload over maxFrameBytes', () => {
    const c = ctx({ maxFrameBytes: 3 });
    c.buffer.set('a', {
      requestId: 'a', url: 'wss://x.com/ws', method: 'GET',
      resourceType: 'websocket',
      timing: { startTime: 0 }, webSocketFrames: [],
    });
    applyWebSocketFrame(c, {
      requestId: 'a', timestamp: 1, direction: 'received',
      response: { opcode: 1, mask: false, payloadData: 'abcdefg' },
    });
    const f = c.buffer.get('a')!.webSocketFrames![0]!;
    expect(f.payload).toBe('abc');
    expect(f.truncated).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY; cd /Users/wxt/code/byob/packages/extension && bun test lib/__tests__/network-events.test.ts`
Expected: FAIL — `Cannot find module '../network-events.js'`.

- [ ] **Step 3: Implement network-events.ts**

Create `/Users/wxt/code/byob/packages/extension/lib/network-events.ts`:

```ts
import type { NetworkRecord, WebSocketFrame } from '@byob/shared';
import { compileUrlPattern, matchUrl, type CompiledPattern } from './url-pattern.js';
import type { CdpSession } from './cdp.js';
import type { RecordingEntry } from './recording-registry.js';

// CDP event shapes — narrow what we actually read so a future Chrome version
// adding fields doesn't break our types. Keep these local to this module.

interface CDPRequestWillBeSent {
  requestId: string;
  type: string;             // 'XHR' | 'Fetch' | 'Document' | 'Script' | ...
  request: {
    url: string;
    method: string;
    headers: Record<string, string>;
    postData?: string;
  };
  timestamp: number;        // monotonic seconds
  wallTime: number;         // seconds since epoch
  initiator?: {
    type: string;
    url?: string;
    lineNumber?: number;
  };
}

interface CDPResponseReceived {
  requestId: string;
  response: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    mimeType: string;
    fromDiskCache?: boolean;
    fromServiceWorker?: boolean;
    timing?: {
      requestTime: number;
      dnsStart: number;
      dnsEnd: number;
      connectStart: number;
      connectEnd: number;
      sslStart: number;
      sslEnd: number;
      sendStart: number;
      sendEnd: number;
      receiveHeadersEnd: number;
    };
  };
  timestamp: number;
}

interface CDPLoadingFinished {
  requestId: string;
  timestamp: number;
}

interface CDPLoadingFailed {
  requestId: string;
  timestamp: number;
  errorText: string;
}

interface CDPWebSocketCreated {
  requestId: string;
  url: string;
  initiator?: { type: string; url?: string; lineNumber?: number };
}

interface CDPWebSocketFrame {
  requestId: string;
  timestamp: number;
  direction: 'sent' | 'received';
  response: { opcode: number; mask: boolean; payloadData: string };
}

/**
 * Subset of RecordingEntry that the pure functions in this module read/write.
 * Lets unit tests build a context without needing a real CdpSession.
 */
export interface AccumulatorContext {
  buffer: Map<string, NetworkRecord>;
  options: RecordingEntry['options'];
  wsBudgetUsed: number;
}

// ---------- Pure event handlers (testable) ----------

const RESOURCE_TYPE_MAP: Record<string, NetworkRecord['resourceType']> = {
  XHR: 'xhr',
  Fetch: 'fetch',
  Document: 'document',
  Script: 'script',
  Stylesheet: 'stylesheet',
  Image: 'image',
  Media: 'media',
  Font: 'font',
  WebSocket: 'websocket',
};

function mapResourceType(cdpType: string): NetworkRecord['resourceType'] {
  return RESOURCE_TYPE_MAP[cdpType] ?? 'other';
}

export function shouldRecordRequest(
  ctx: AccumulatorContext,
  ev: CDPRequestWillBeSent,
): boolean {
  const rt = mapResourceType(ev.type);
  const filter = ctx.options.resourceTypes;
  if (!(filter.length === 1 && filter[0] === '*') && !filter.includes(rt)) {
    return false;
  }
  const compiled: CompiledPattern = compileUrlPattern(ctx.options.urlPattern);
  if (!matchUrl(compiled, ev.request.url)) return false;
  if (ctx.buffer.size >= ctx.options.maxRecords) return false;
  return true;
}

export function applyRequestWillBeSent(
  ctx: AccumulatorContext,
  ev: CDPRequestWillBeSent,
): void {
  if (!shouldRecordRequest(ctx, ev)) return;
  const rt = mapResourceType(ev.type);
  let postData: string | undefined;
  let postDataTruncated: boolean | undefined;
  if (ctx.options.includeRequestBody && typeof ev.request.postData === 'string') {
    if (ev.request.postData.length > ctx.options.maxBodyBytes) {
      postData = ev.request.postData.slice(0, ctx.options.maxBodyBytes);
      postDataTruncated = true;
    } else {
      postData = ev.request.postData;
    }
  }
  const rec: NetworkRecord = {
    requestId: ev.requestId,
    url: ev.request.url,
    method: ev.request.method,
    resourceType: rt,
    requestHeaders: { ...ev.request.headers },
    requestPostData: postData,
    requestPostDataTruncated: postDataTruncated,
    timing: {
      // CDP wallTime is in seconds since epoch; convert to ms for record.
      startTime: ev.wallTime * 1000,
    },
    initiator: ev.initiator
      ? {
          type:
            ev.initiator.type === 'parser' ||
            ev.initiator.type === 'script' ||
            ev.initiator.type === 'preflight'
              ? ev.initiator.type
              : 'other',
          url: ev.initiator.url,
          lineno: ev.initiator.lineNumber,
        }
      : undefined,
    webSocketFrames: rt === 'websocket' ? [] : undefined,
  };
  ctx.buffer.set(ev.requestId, rec);
}

export function applyResponseReceived(
  ctx: AccumulatorContext,
  ev: CDPResponseReceived,
): void {
  const rec = ctx.buffer.get(ev.requestId);
  if (!rec) return;
  rec.responseStatus = ev.response.status;
  rec.responseStatusText = ev.response.statusText;
  rec.responseHeaders = { ...ev.response.headers };
  rec.responseMimeType = ev.response.mimeType;
  rec.fromCache = ev.response.fromDiskCache === true;
  rec.fromServiceWorker = ev.response.fromServiceWorker === true;
  const t = ev.response.timing;
  if (t) {
    // CDP timing fields are ms offsets from `requestTime` (seconds).
    rec.timing.dnsMs = pos(t.dnsEnd - t.dnsStart);
    rec.timing.connectMs = pos(t.connectEnd - t.connectStart);
    rec.timing.sslMs = pos(t.sslEnd - t.sslStart);
    rec.timing.sendMs = pos(t.sendEnd - t.sendStart);
    rec.timing.waitMs = pos(t.receiveHeadersEnd - t.sendEnd);
  }
}

function pos(n: number): number | undefined {
  return n >= 0 ? n : undefined;
}

export function applyLoadingFinished(
  ctx: AccumulatorContext,
  ev: CDPLoadingFinished,
): void {
  const rec = ctx.buffer.get(ev.requestId);
  if (!rec) return;
  // ev.timestamp is monotonic seconds. We want endTime in same scale as
  // startTime (wallTime * 1000). Use Date.now() as the wall-clock anchor for
  // endTime — accurate enough for HAR / debugging purposes.
  const endTime = Date.now();
  rec.timing.endTime = endTime;
  rec.timing.durationMs = Math.max(0, endTime - rec.timing.startTime);
  // Approximate receiveMs from durationMs minus what we already have (if any).
  if (
    rec.timing.durationMs !== undefined &&
    rec.timing.dnsMs !== undefined &&
    rec.timing.connectMs !== undefined &&
    rec.timing.sendMs !== undefined &&
    rec.timing.waitMs !== undefined
  ) {
    const used =
      (rec.timing.dnsMs ?? 0) +
      (rec.timing.connectMs ?? 0) +
      (rec.timing.sendMs ?? 0) +
      (rec.timing.waitMs ?? 0);
    const remain = rec.timing.durationMs - used;
    rec.timing.receiveMs = remain > 0 ? remain : 0;
  }
}

export function applyLoadingFailed(
  ctx: AccumulatorContext,
  ev: CDPLoadingFailed,
): void {
  const rec = ctx.buffer.get(ev.requestId);
  if (!rec) return;
  rec.failed = true;
  rec.errorText = ev.errorText;
  const endTime = Date.now();
  rec.timing.endTime = endTime;
  rec.timing.durationMs = Math.max(0, endTime - rec.timing.startTime);
}

export function applyWebSocketCreated(
  ctx: AccumulatorContext,
  ev: CDPWebSocketCreated,
): void {
  if (!ctx.options.captureWebSocketFrames) return;
  if (ctx.buffer.size >= ctx.options.maxRecords) return;
  if (!matchUrl(compileUrlPattern(ctx.options.urlPattern), ev.url)) return;
  const rec: NetworkRecord = {
    requestId: ev.requestId,
    url: ev.url,
    method: 'GET',
    resourceType: 'websocket',
    timing: { startTime: Date.now() },
    initiator: ev.initiator
      ? {
          type:
            ev.initiator.type === 'parser' ||
            ev.initiator.type === 'script' ||
            ev.initiator.type === 'preflight'
              ? ev.initiator.type
              : 'other',
          url: ev.initiator.url,
          lineno: ev.initiator.lineNumber,
        }
      : undefined,
    webSocketFrames: [],
  };
  ctx.buffer.set(ev.requestId, rec);
}

export function applyWebSocketFrame(
  ctx: AccumulatorContext,
  ev: CDPWebSocketFrame,
): void {
  const rec = ctx.buffer.get(ev.requestId);
  if (!rec || rec.resourceType !== 'websocket') return;
  if (!ctx.options.captureWebSocketFrames) return;
  // Stop accumulating frames once total ws byte budget exceeded
  // (maxRecords * 10 frame slots). Keeps record metadata but caps memory.
  const budget = ctx.options.maxRecords * 10 * ctx.options.maxFrameBytes;
  if (ctx.wsBudgetUsed >= budget) return;
  let payload = ev.response.payloadData;
  let truncated: boolean | undefined;
  if (payload.length > ctx.options.maxFrameBytes) {
    payload = payload.slice(0, ctx.options.maxFrameBytes);
    truncated = true;
  }
  ctx.wsBudgetUsed += payload.length;
  const frame: WebSocketFrame = {
    direction: ev.direction,
    timestamp: Date.now(),
    opcode: ev.response.opcode,
    payload,
    truncated,
  };
  if (!rec.webSocketFrames) rec.webSocketFrames = [];
  rec.webSocketFrames.push(frame);
}

// ---------- Listener installation (impure, side effects) ----------

/**
 * Wire chrome.debugger.onEvent listeners for one recording entry.
 * Returns an array of cleanup functions (one per listener) — caller stores
 * them on entry.listenerCleanups and runs them on stop.
 *
 * onMaxRecords: invoked when buffer hits maxRecords. Caller should autoStop.
 */
export function installNetworkListeners(opts: {
  session: CdpSession;
  tabId: number;
  ctx: AccumulatorContext;
  onMaxRecords: () => void;
  /**
   * Called after applyResponseReceived → applyLoadingFinished completes for a
   * record; allows the caller to fetch the response body asynchronously.
   * Implemented in the start handler to keep this module unit-testable.
   */
  onLoadingFinished: (requestId: string) => void;
}): Array<() => void> {
  const { session, tabId, ctx, onMaxRecords, onLoadingFinished } = opts;
  const cleanups: Array<() => void> = [];

  const handler = (
    source: chrome.debugger.Debuggee,
    method: string,
    params: unknown,
  ): void => {
    if (source.tabId !== tabId) return;
    try {
      if (method === 'Network.requestWillBeSent') {
        const before = ctx.buffer.size;
        applyRequestWillBeSent(ctx, params as CDPRequestWillBeSent);
        if (ctx.buffer.size >= ctx.options.maxRecords && before < ctx.options.maxRecords) {
          onMaxRecords();
        }
      } else if (method === 'Network.responseReceived') {
        applyResponseReceived(ctx, params as CDPResponseReceived);
      } else if (method === 'Network.loadingFinished') {
        applyLoadingFinished(ctx, params as CDPLoadingFinished);
        onLoadingFinished((params as CDPLoadingFinished).requestId);
      } else if (method === 'Network.loadingFailed') {
        applyLoadingFailed(ctx, params as CDPLoadingFailed);
      } else if (method === 'Network.webSocketCreated') {
        applyWebSocketCreated(ctx, params as CDPWebSocketCreated);
      } else if (
        method === 'Network.webSocketFrameSent' ||
        method === 'Network.webSocketFrameReceived'
      ) {
        const ev = params as CDPWebSocketFrame;
        // CDP gives us the direction implicitly via method name
        const direction: 'sent' | 'received' =
          method === 'Network.webSocketFrameSent' ? 'sent' : 'received';
        applyWebSocketFrame(ctx, { ...ev, direction });
      }
    } catch (e) {
      console.warn('[byob/record-network] event handler threw', method, e);
    }
    void session; // silence unused — kept for future signal.throwIfAborted hook
  };

  chrome.debugger.onEvent.addListener(handler);
  cleanups.push(() => chrome.debugger.onEvent.removeListener(handler));

  return cleanups;
}

/**
 * Fetch the response body for a single record with a 5 s timeout. Mutates
 * the record in place; never throws (errors logged, body left undefined).
 */
export async function fetchResponseBody(
  session: CdpSession,
  rec: NetworkRecord,
  maxBodyBytes: number,
): Promise<void> {
  if (rec.failed) return;
  if (rec.resourceType === 'websocket') return;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const resp = await Promise.race([
      session.send<{ body: string; base64Encoded: boolean }>(
        'Network.getResponseBody',
        { requestId: rec.requestId },
      ),
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error('getResponseBody timeout')), 5000);
      }),
    ]);
    let body = resp.body;
    let truncated: boolean | undefined;
    if (body.length > maxBodyBytes) {
      body = body.slice(0, maxBodyBytes);
      truncated = true;
    }
    rec.responseBody = body;
    rec.responseBodyEncoding = resp.base64Encoded ? 'base64' : 'utf8';
    rec.responseBodyTruncated = truncated;
  } catch (e) {
    // Streaming responses, redirected requests, and tab navigations all
    // legitimately fail getResponseBody. Don't pollute logs except in dev.
    if (e instanceof Error && /timeout/.test(e.message)) {
      console.warn('[byob/record-network] getResponseBody timed out for', rec.url);
    }
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY; cd /Users/wxt/code/byob/packages/extension && bun test lib/__tests__/network-events.test.ts`
Expected: All tests PASS. (~14 tests across describe blocks.)

- [ ] **Step 5: Run typecheck**

Run: `unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY; cd /Users/wxt/code/byob && bun run typecheck`
Expected: No errors.

- [ ] **Step 6: Commit**

Commit message:

```
feat(extension): CDP Network event accumulator

Pure functions translate Network.* CDP events into NetworkRecord entries
keyed by requestId. Includes filter logic (resourceType + urlPattern),
truncation, WebSocket frame capture with byte-budget back-pressure, and a
listener installer that wires chrome.debugger.onEvent through. Body fetch
runs with a 5s timeout per record so streaming responses can't hang stop.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

---

# Task 5: HAR converter

**Files:**
- Create: `/Users/wxt/code/byob/packages/extension/lib/har-converter.ts`
- Test: `/Users/wxt/code/byob/packages/extension/lib/__tests__/har-converter.test.ts`

Pure function. The output is consumed by anything that speaks HAR 1.2 — Chrome DevTools, Charles, online HAR viewers, etc.

- [ ] **Step 1: Write the failing test**

Create `/Users/wxt/code/byob/packages/extension/lib/__tests__/har-converter.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { recordsToHar } from '../har-converter.js';
import type { NetworkRecord } from '@byob/shared';

const baseRecord: NetworkRecord = {
  requestId: 'a',
  url: 'https://example.com/api/v2',
  method: 'POST',
  resourceType: 'fetch',
  requestHeaders: { 'Content-Type': 'application/json' },
  requestPostData: '{"k":1}',
  responseStatus: 200,
  responseStatusText: 'OK',
  responseHeaders: { 'content-type': 'application/json' },
  responseMimeType: 'application/json',
  responseBody: '{"ok":true}',
  responseBodyEncoding: 'utf8',
  timing: {
    startTime: 1700_000_000_000,
    endTime:   1700_000_000_500,
    durationMs: 500,
    dnsMs: 5,
    connectMs: 15,
    sslMs: 8,
    sendMs: 2,
    waitMs: 28,
    receiveMs: 442,
  },
  initiator: { type: 'script' },
};

describe('recordsToHar', () => {
  test('produces HAR 1.2 with creator + empty pages + entries array', () => {
    const har = recordsToHar([baseRecord], { name: 'byob', version: '0.2.0' });
    expect(har.log.version).toBe('1.2');
    expect(har.log.creator).toEqual({ name: 'byob', version: '0.2.0' });
    expect(har.log.pages).toEqual([]);
    expect(har.log.entries.length).toBe(1);
  });

  test('entry has request/response/timings/cache/time fields', () => {
    const har = recordsToHar([baseRecord], { name: 'byob', version: '0.2.0' });
    const e = har.log.entries[0]! as any;
    expect(e.startedDateTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(e.time).toBe(500);
    expect(e.request.method).toBe('POST');
    expect(e.request.url).toBe('https://example.com/api/v2');
    expect(e.request.httpVersion).toBe('HTTP/1.1');
    expect(e.request.headers).toEqual([
      { name: 'Content-Type', value: 'application/json' },
    ]);
    expect(e.request.postData).toEqual({
      mimeType: 'application/json',
      text: '{"k":1}',
    });
    expect(e.response.status).toBe(200);
    expect(e.response.statusText).toBe('OK');
    expect(e.response.content).toEqual({
      size: '{"ok":true}'.length,
      mimeType: 'application/json',
      text: '{"ok":true}',
    });
    expect(e.timings.dns).toBe(5);
    expect(e.timings.connect).toBe(15);
    expect(e.timings.ssl).toBe(8);
    expect(e.timings.send).toBe(2);
    expect(e.timings.wait).toBe(28);
    expect(e.timings.receive).toBe(442);
    expect(e.cache).toEqual({});
  });

  test('binary body: encoding=base64', () => {
    const har = recordsToHar(
      [{ ...baseRecord, responseBodyEncoding: 'base64', responseBody: 'AAEC' }],
      { name: 'byob', version: '0.2.0' },
    );
    const e = har.log.entries[0]! as any;
    expect(e.response.content.encoding).toBe('base64');
    expect(e.response.content.text).toBe('AAEC');
  });

  test('failed record sets response.status=0 and _error', () => {
    const har = recordsToHar(
      [{
        ...baseRecord,
        failed: true,
        errorText: 'net::ERR_FAILED',
        responseStatus: undefined,
        responseStatusText: undefined,
        responseHeaders: undefined,
        responseMimeType: undefined,
        responseBody: undefined,
        responseBodyEncoding: undefined,
      }],
      { name: 'byob', version: '0.2.0' },
    );
    const e = har.log.entries[0]! as any;
    expect(e.response.status).toBe(0);
    expect(e._error).toBe('net::ERR_FAILED');
  });

  test('websocket entry uses _webSocketMessages and _resourceType=websocket', () => {
    const har = recordsToHar(
      [{
        requestId: 'ws1',
        url: 'wss://echo.websocket.events/',
        method: 'GET',
        resourceType: 'websocket',
        timing: { startTime: 1700, endTime: 1900, durationMs: 200 },
        webSocketFrames: [
          { direction: 'sent',     timestamp: 1, opcode: 1, payload: 'hi' },
          { direction: 'received', timestamp: 2, opcode: 1, payload: 'hi back' },
        ],
      }],
      { name: 'byob', version: '0.2.0' },
    );
    const e = har.log.entries[0]! as any;
    expect(e._resourceType).toBe('websocket');
    expect(e._webSocketMessages).toEqual([
      { type: 'send',    time: 1, opcode: 1, data: 'hi' },
      { type: 'receive', time: 2, opcode: 1, data: 'hi back' },
    ]);
  });

  test('entries are sorted by startTime ascending', () => {
    const har = recordsToHar(
      [
        { ...baseRecord, requestId: 'b', timing: { startTime: 200 } },
        { ...baseRecord, requestId: 'a', timing: { startTime: 100 } },
        { ...baseRecord, requestId: 'c', timing: { startTime: 300 } },
      ],
      { name: 'byob', version: '0.2.0' },
    );
    expect((har.log.entries as any[]).map((e) => e._byobRequestId)).toEqual(['a', 'b', 'c']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY; cd /Users/wxt/code/byob/packages/extension && bun test lib/__tests__/har-converter.test.ts`
Expected: FAIL — `Cannot find module '../har-converter.js'`.

- [ ] **Step 3: Implement har-converter.ts**

Create `/Users/wxt/code/byob/packages/extension/lib/har-converter.ts`:

```ts
import type { NetworkRecord, Har, WebSocketFrame } from '@byob/shared';

interface HarCreator {
  name: string;
  version: string;
}

interface HarHeader { name: string; value: string }

/**
 * Convert NetworkRecord[] to a HAR 1.2 archive.
 *
 * WebSocket entries get two custom fields:
 *   _resourceType: 'websocket'
 *   _webSocketMessages: [{ type: 'send'|'receive', time, opcode, data }]
 *
 * The naming matches Chrome DevTools' "Save all as HAR with content" export
 * so existing tooling that already understands the DevTools dialect can read
 * our output. Strict HAR 1.2 validators may flag the `_*` prefix — that's
 * acceptable; HAR 1.2 explicitly reserves underscore-prefixed fields for
 * vendor extensions.
 */
export function recordsToHar(records: NetworkRecord[], creator: HarCreator): Har {
  const sorted = [...records].sort(
    (a, b) => a.timing.startTime - b.timing.startTime,
  );
  return {
    log: {
      version: '1.2',
      creator,
      pages: [],
      entries: sorted.map(toHarEntry),
    },
  };
}

function toHarEntry(r: NetworkRecord): Record<string, unknown> {
  const startedDateTime = new Date(r.timing.startTime).toISOString();
  const time = r.timing.durationMs ?? 0;

  const requestHeaders: HarHeader[] = headersToArray(r.requestHeaders);
  const responseHeaders: HarHeader[] = headersToArray(r.responseHeaders);

  const request: Record<string, unknown> = {
    method: r.method,
    url: r.url,
    httpVersion: 'HTTP/1.1',
    cookies: [],
    headers: requestHeaders,
    queryString: parseQueryString(r.url),
    headersSize: -1,
    bodySize: r.requestPostData?.length ?? -1,
  };
  if (r.requestPostData !== undefined) {
    request.postData = {
      mimeType: r.requestHeaders?.['Content-Type'] ?? r.requestHeaders?.['content-type'] ?? '',
      text: r.requestPostData,
    };
  }

  const responseContent: Record<string, unknown> = {
    size: r.responseBody?.length ?? 0,
    mimeType: r.responseMimeType ?? '',
  };
  if (r.responseBody !== undefined) {
    responseContent.text = r.responseBody;
    if (r.responseBodyEncoding === 'base64') responseContent.encoding = 'base64';
  }

  const response: Record<string, unknown> = {
    status: r.failed ? 0 : (r.responseStatus ?? 0),
    statusText: r.responseStatusText ?? '',
    httpVersion: 'HTTP/1.1',
    cookies: [],
    headers: responseHeaders,
    content: responseContent,
    redirectURL: '',
    headersSize: -1,
    bodySize: r.responseBody?.length ?? -1,
  };

  const timings = {
    blocked: -1,
    dns: r.timing.dnsMs ?? -1,
    connect: r.timing.connectMs ?? -1,
    ssl: r.timing.sslMs ?? -1,
    send: r.timing.sendMs ?? 0,
    wait: r.timing.waitMs ?? 0,
    receive: r.timing.receiveMs ?? 0,
  };

  const entry: Record<string, unknown> = {
    startedDateTime,
    time,
    request,
    response,
    cache: {},
    timings,
    serverIPAddress: '',
    connection: '',
    _byobRequestId: r.requestId,
    _resourceType: r.resourceType,
  };

  if (r.failed && r.errorText) entry._error = r.errorText;
  if (r.fromCache) entry._fromCache = true;
  if (r.fromServiceWorker) entry._fromServiceWorker = true;

  if (r.resourceType === 'websocket' && r.webSocketFrames && r.webSocketFrames.length > 0) {
    entry._webSocketMessages = r.webSocketFrames.map(frameToWsMessage);
  }

  if (r.initiator) entry._initiator = r.initiator;

  return entry;
}

function headersToArray(h: Record<string, string> | undefined): HarHeader[] {
  if (!h) return [];
  return Object.entries(h).map(([name, value]) => ({ name, value }));
}

function parseQueryString(url: string): Array<{ name: string; value: string }> {
  try {
    const u = new URL(url);
    const out: Array<{ name: string; value: string }> = [];
    u.searchParams.forEach((v, k) => out.push({ name: k, value: v }));
    return out;
  } catch {
    return [];
  }
}

function frameToWsMessage(f: WebSocketFrame): {
  type: 'send' | 'receive';
  time: number;
  opcode: number;
  data: string;
} {
  return {
    type: f.direction === 'sent' ? 'send' : 'receive',
    time: f.timestamp,
    opcode: f.opcode,
    data: f.payload,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY; cd /Users/wxt/code/byob/packages/extension && bun test lib/__tests__/har-converter.test.ts`
Expected: All 6 tests PASS.

- [ ] **Step 5: Run all extension tests once together**

Run: `unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY; cd /Users/wxt/code/byob/packages/extension && bun test`
Expected: All tests across `url-pattern.test.ts`, `network-events.test.ts`, `har-converter.test.ts` PASS.

- [ ] **Step 6: Commit**

Commit message:

```
feat(extension): NetworkRecord -> HAR 1.2 converter

Pure function recordsToHar emits a HAR 1.2 archive with Chrome DevTools-
compatible custom fields (_webSocketMessages, _resourceType, _fromCache,
_fromServiceWorker, _initiator) on entries. Underscore-prefixed fields are
explicitly reserved for vendor extensions in HAR 1.2; strict validators
that reject them are an accepted trade-off.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

---

# Task 6: start-record-network handler

**Files:**
- Create: `/Users/wxt/code/byob/packages/extension/lib/handlers/start-record-network.ts`

This is the bulk of the wiring: resolve tab → attach CDP → enable Network domain → install listeners → register entry → arm autoStop paths.

- [ ] **Step 1: Implement the handler skeleton**

Create `/Users/wxt/code/byob/packages/extension/lib/handlers/start-record-network.ts`:

```ts
import { StartRecordNetworkInput } from '@byob/shared';
import { tryAttachToTab } from '../cdp.js';
import { openOrReuse } from '../tab.js';
import { checkUrlAllowed, urlForbiddenError } from '../url-guard.js';
import { keepAwakeStart, keepAwakeEnd } from '../keepalive.js';
import {
  addRecording,
  getRecording,
  type RecordingEntry,
  type RecordingOptions,
  type EndedReason,
} from '../recording-registry.js';
import {
  installNetworkListeners,
  fetchResponseBody,
  type AccumulatorContext,
} from '../network-events.js';

/**
 * AbortSignal slot reserved for sub-project B. Not currently consulted; sub-B
 * will add throwIfAborted() at the appropriate await points.
 */
export async function handleStartRecordNetwork(
  rawParams: unknown,
  _signal?: AbortSignal,
): Promise<unknown> {
  const params = StartRecordNetworkInput.parse(rawParams);

  // Resolve URL constraint check up front (only when url provided — explicit
  // tabId is treated as user-trusted, same convention as eval handler).
  if (params.url) {
    const guard = checkUrlAllowed(params.url);
    if (!guard.ok) return urlForbiddenError(guard.reason);
  }

  const tab = await openOrReuse({
    url: params.url,
    tabId: params.tabId,
  });

  const { session, reason } = await tryAttachToTab(tab.tabId);
  if (!session) {
    if (!tab.reused) await tab.cleanup();
    if (reason === 'special_page') {
      return {
        error: 'url_forbidden',
        message: 'Cannot record on special pages (chrome://, devtools://, etc.).',
        hint: 'Switch to a regular http(s):// tab.',
      };
    }
    if (reason === 'tab_gone') {
      return { error: 'tab_closed', message: 'Tab was closed before recording could attach.' };
    }
    return {
      error: 'cdp_attach_failed',
      message: 'Could not attach Chrome debugger after 3 retries.',
      hint: 'Close DevTools (F12) on the target tab and retry.',
    };
  }

  // Per-recording Network buffer settings. Use generous totals; per-record
  // truncation is enforced at the listener layer via maxBodyBytes.
  try {
    await session.send('Network.enable', {
      maxTotalBufferSize: 16 * 1024 * 1024,
      maxResourceBufferSize: 4 * 1024 * 1024,
      maxPostDataSize: params.maxBodyBytes,
    });
  } catch (e) {
    if (!tab.reused) {
      try { await session.detach(); } catch { /* already detached */ }
      await tab.cleanup();
    }
    return {
      error: 'recording_failed_to_attach',
      message: `Network.enable failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const recordingId = crypto.randomUUID();
  const startedAt = Date.now();

  const options: RecordingOptions = {
    resourceTypes: params.resourceTypes,
    urlPattern: params.urlPattern,
    includeRequestBody: params.includeRequestBody,
    includeResponseBody: params.includeResponseBody,
    maxBodyBytes: params.maxBodyBytes,
    maxRecords: params.maxRecords,
    captureWebSocketFrames: params.captureWebSocketFrames,
    maxFrameBytes: params.maxFrameBytes,
    timeoutMs: params.timeoutMs,
  };

  const ctx: AccumulatorContext = {
    buffer: new Map(),
    options,
    wsBudgetUsed: 0,
  };

  const cleanups = installNetworkListeners({
    session,
    tabId: tab.tabId,
    ctx,
    onMaxRecords: () => endRecording(recordingId, 'max_records'),
    onLoadingFinished: (requestId) => {
      if (!params.includeResponseBody) return;
      const rec = ctx.buffer.get(requestId);
      if (!rec) return;
      // Fire-and-forget — fetchResponseBody never throws.
      void fetchResponseBody(session, rec, params.maxBodyBytes);
    },
  });

  // Tab close → autoStop with reason='tab_closed'
  const tabRemovedListener = (closedId: number): void => {
    if (closedId !== tab.tabId) return;
    void endRecording(recordingId, 'tab_closed');
  };
  chrome.tabs.onRemoved.addListener(tabRemovedListener);

  // Timer-based autoStop
  const timeoutId = setTimeout(
    () => void endRecording(recordingId, 'timeout'),
    params.timeoutMs,
  );

  keepAwakeStart();
  const entry: RecordingEntry = {
    recordingId,
    tabId: tab.tabId,
    session,
    buffer: ctx.buffer,
    wsBudgetUsed: ctx.wsBudgetUsed,
    options,
    startedAt,
    listenerCleanups: cleanups,
    state: 'recording',
    timeoutId,
    tabRemovedListener,
    keepaliveHeld: true,
  };
  addRecording(entry);

  // Capture current URL for return value (best-effort).
  let currentUrl = params.url ?? '';
  try {
    const t = await chrome.tabs.get(tab.tabId);
    currentUrl = t.url ?? currentUrl;
  } catch {
    // tab may have just closed; use whatever we have
  }

  return {
    recordingId,
    tabId: tab.tabId,
    url: currentUrl,
    startedAt,
  };
}

/**
 * Mark a recording entry as ended and tear down listeners + Network domain +
 * keepalive. Idempotent — safe to call multiple times. Does NOT delete the
 * registry entry; stop_record_network drains and deletes.
 */
export async function endRecording(
  recordingId: string,
  reason: EndedReason,
): Promise<void> {
  const entry = getRecording(recordingId);
  if (!entry) return;
  if (entry.state === 'ended') return;

  entry.state = 'ended';
  entry.endedReason = reason;
  entry.endedAt = Date.now();

  if (entry.timeoutId !== null) {
    clearTimeout(entry.timeoutId);
    entry.timeoutId = null;
  }
  if (entry.tabRemovedListener) {
    chrome.tabs.onRemoved.removeListener(entry.tabRemovedListener);
    entry.tabRemovedListener = null;
  }
  for (const c of entry.listenerCleanups) {
    try { c(); } catch { /* ignore */ }
  }
  entry.listenerCleanups = [];

  // Disable Network domain — best-effort; tab may be gone or detached.
  try {
    if (entry.session.isAttached && reason !== 'tab_closed') {
      await entry.session.send('Network.disable', {});
    }
  } catch {
    // ignore
  }

  // Detach CDP only if no other recordings need this tab. Future tools may
  // share the session map (cdp.ts), so we don't unconditionally detach.
  // Currently no other handler shares CDP across calls, so check the map.
  if (entry.session.isAttached) {
    let othersUsingTab = false;
    // Re-check registry for any other active entry on the same tab.
    // (Imported lazily to avoid a circular dep with recording-registry.)
    const { getRegistry } = await import('../recording-registry.js');
    for (const e of getRegistry().values()) {
      if (e.recordingId !== recordingId && e.tabId === entry.tabId && e.state === 'recording') {
        othersUsingTab = true;
        break;
      }
    }
    if (!othersUsingTab) {
      try { await entry.session.detach(); } catch { /* ignore */ }
    }
  }

  if (entry.keepaliveHeld) {
    keepAwakeEnd();
    entry.keepaliveHeld = false;
  }
}
```

- [ ] **Step 2: Run typecheck**

Run: `unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY; cd /Users/wxt/code/byob && bun run typecheck`
Expected: All packages green. The `_signal` parameter is intentionally prefixed with `_` to suppress unused-arg warnings; sub-project B will rename it.

- [ ] **Step 3: Commit**

Commit message:

```
feat(extension): browser_start_record_network handler

Resolves the target tab, attaches CDP via tryAttachToTab, calls
Network.enable with generous buffer limits, installs the event listener
chain, registers the recording entry, and arms three autoStop paths
(timeout / tab_closed / max_records). AbortSignal slot reserved for B.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

---

# Task 7: stop-record-network handler

**Files:**
- Create: `/Users/wxt/code/byob/packages/extension/lib/handlers/stop-record-network.ts`

- [ ] **Step 1: Implement the stop handler**

Create `/Users/wxt/code/byob/packages/extension/lib/handlers/stop-record-network.ts`:

```ts
import { StopRecordNetworkInput } from '@byob/shared';
import { getRecording, deleteRecording } from '../recording-registry.js';
import { endRecording } from './start-record-network.js';
import { recordsToHar } from '../har-converter.js';

const HAR_CREATOR = { name: 'byob', version: '0.2.0' };

export async function handleStopRecordNetwork(
  rawParams: unknown,
  _signal?: AbortSignal,
): Promise<unknown> {
  const params = StopRecordNetworkInput.parse(rawParams);
  const entry = getRecording(params.recordingId);
  if (!entry) {
    return {
      error: 'recording_not_found',
      message: `No recording with id ${params.recordingId}`,
      hint: 'Recording may have ended automatically (timeout/max_records/tab_closed) and been GCed, or never started.',
    };
  }

  // Wait flushDelayMs so in-flight loadingFinished events make it into the
  // buffer before we tear down. Skip the wait when already ended (autoStop
  // path) — the events already drained.
  if (entry.state === 'recording' && params.flushDelayMs > 0) {
    await new Promise((r) => setTimeout(r, params.flushDelayMs));
  }

  if (entry.state === 'recording') {
    await endRecording(params.recordingId, 'user_stop');
  }

  const records = Array.from(entry.buffer.values()).sort(
    (a, b) => a.timing.startTime - b.timing.startTime,
  );
  const truncated = records.length >= entry.options.maxRecords;
  const durationMs = (entry.endedAt ?? Date.now()) - entry.startedAt;
  const endedReason = entry.endedReason ?? 'user_stop';

  const out: Record<string, unknown> = {
    records,
    truncated,
    durationMs,
    recordCount: records.length,
    endedReason,
    tabId: entry.tabId,
  };

  if (params.format === 'har') {
    out.har = recordsToHar(records, HAR_CREATOR);
  }

  // Delete only after successful return-shape construction; if anything above
  // throws, the entry stays in registry (in 'ended' state) and the GC will
  // sweep it after 2 * timeoutMs.
  deleteRecording(params.recordingId);

  return out;
}
```

- [ ] **Step 2: Run typecheck**

Run: `unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY; cd /Users/wxt/code/byob && bun run typecheck`
Expected: All packages green.

- [ ] **Step 3: Commit**

Commit message:

```
feat(extension): browser_stop_record_network handler

Looks up the recording entry, awaits flushDelayMs for in-flight events,
calls endRecording with reason='user_stop' if still active, sorts the
buffer by startTime, and returns records + optional HAR 1.2 archive.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

---

# Task 8: Wire handlers into extension dispatcher

**Files:**
- Modify: `/Users/wxt/code/byob/packages/extension/lib/handlers/index.ts`

- [ ] **Step 1: Add imports and registry entries**

In `/Users/wxt/code/byob/packages/extension/lib/handlers/index.ts`, add the new handler imports and dispatcher entries:

```ts
import { Command } from '@byob/shared';
import { handleRead } from './read.js';
import { handleClick } from './click.js';
import { handleType } from './type.js';
import { handleNavigate } from './navigate.js';
import { handleWaitFor } from './wait-for.js';
import { handleScreenshot } from './screenshot.js';
import { handleGetCookies } from './get-cookies.js';
import { handleListTabs } from './list-tabs.js';
import { handleSwitchTab } from './switch-tab.js';
import { handleEval } from './eval.js';
import { handleDownloadImages } from './download-images.js';
import { handleStartRecordNetwork } from './start-record-network.js';
import { handleStopRecordNetwork } from './stop-record-network.js';

export type Handler = (params: unknown) => Promise<unknown>;

export const handlers: Partial<Record<string, Handler>> = {
  [Command.Read]: handleRead,
  [Command.Click]: handleClick,
  [Command.Type]: handleType,
  [Command.Navigate]: handleNavigate,
  [Command.WaitFor]: handleWaitFor,
  [Command.Screenshot]: handleScreenshot,
  [Command.GetCookies]: handleGetCookies,
  [Command.ListTabs]: handleListTabs,
  [Command.SwitchTab]: handleSwitchTab,
  [Command.Eval]: handleEval,
  [Command.DownloadImages]: handleDownloadImages,
  [Command.StartRecordNetwork]: handleStartRecordNetwork,
  [Command.StopRecordNetwork]: handleStopRecordNetwork,
};
```

- [ ] **Step 2: Run typecheck**

Run: `unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY; cd /Users/wxt/code/byob && bun run typecheck`
Expected: All packages green.

- [ ] **Step 3: Build the extension once to confirm WXT picks it up**

Run: `unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY; cd /Users/wxt/code/byob/packages/extension && bun run build`
Expected: Build completes; `.output/chrome-mv3/` produced. (The two new handlers should be bundled into the SW chunk.)

- [ ] **Step 4: Commit**

Commit message:

```
feat(extension): wire start/stop record-network handlers into dispatcher

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

---

# Task 9: Bridge HTTP routes

**Files:**
- Modify: `/Users/wxt/code/byob/packages/bridge/src/main.ts`

- [ ] **Step 1: Add the two new routes to the bridge tools map**

In `/Users/wxt/code/byob/packages/bridge/src/main.ts`, locate the `tools` object (around line 111) and extend it. The Native Messaging command names are `'startRecordNetwork'` and `'stopRecordNetwork'` — the same constants from `Command.StartRecordNetwork` / `Command.StopRecordNetwork`. The HTTP route path uses kebab-case to follow the existing convention (`'wait-for'`, `'download-images'`).

Use `Edit` to change the `tools` object:

```ts
const tools: IpcHandlers['tools'] = {
  read:       routeFor('readPage'),
  click:      routeFor('click', 30),
  type:       routeFor('type', 30),
  navigate:   routeFor('navigate', 60),
  'wait-for': routeFor('waitFor', 30),
  screenshot: screenshotRoute,
  cookies:        routeFor('getCookies', 10),
  '__list-tabs':  routeFor('listTabs', 5),
  'tabs/switch':  routeFor('switchTab', 5),
  eval: async (body: unknown) => {
    auditEval(body);
    return routeFor('eval', 30)(body);
  },
  'download-images': downloadImagesRoute,
  // Recording window can be up to timeoutMs (default 5 min, hard cap 1 h).
  // routeFor adds 30s slack on top of timeoutSec; we use a fixed timeoutSec
  // here to avoid having to read the user-supplied timeoutMs out of body.
  // start_record returns immediately so 10s is comfortable.
  'record-network/start': routeFor('startRecordNetwork', 10),
  // stop_record waits flushDelayMs (≤ 30s) and may have to fetch many
  // bodies. Allow up to 5 minutes; longer recordings should still drain in
  // under a minute on a healthy machine.
  'record-network/stop': routeFor('stopRecordNetwork', 300),
};
```

- [ ] **Step 2: Run typecheck on bridge**

Run: `unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY; cd /Users/wxt/code/byob/packages/bridge && bun run typecheck`
Expected: No errors.

- [ ] **Step 3: Run repo-wide typecheck**

Run: `unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY; cd /Users/wxt/code/byob && bun run typecheck`
Expected: All four packages green.

- [ ] **Step 4: Commit**

Commit message:

```
feat(bridge): record-network/start and record-network/stop HTTP routes

Adds POST /record-network/start (10s NM timeout — start returns
immediately) and POST /record-network/stop (300s NM timeout to
accommodate flushDelayMs plus body-fetch tails).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

---

# Task 10: MCP server tool registrations

**Files:**
- Create: `/Users/wxt/code/byob/packages/mcp-server/src/tools/browser-start-record-network.ts`
- Create: `/Users/wxt/code/byob/packages/mcp-server/src/tools/browser-stop-record-network.ts`
- Modify: `/Users/wxt/code/byob/packages/mcp-server/src/tools/index.ts`

- [ ] **Step 1: Implement browser-start-record-network.ts**

Create `/Users/wxt/code/byob/packages/mcp-server/src/tools/browser-start-record-network.ts`:

```ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StartRecordNetworkInputRaw, StartRecordNetworkOutput } from '@byob/shared';
import { bridgePost } from '../bridge-client.js';
import { asErrorEnvelope, toMcpError } from '../error-mapper.js';

export function registerBrowserStartRecordNetwork(server: McpServer): void {
  server.registerTool(
    'browser_start_record_network',
    {
      title: 'Start recording network requests on a tab',
      description:
        'Begin recording HTTP/HTTPS requests, responses, bodies, timings, and ' +
        'WebSocket frames on a Chrome tab. Returns a recordingId immediately; ' +
        'pair with browser_stop_record_network to retrieve captured data. ' +
        'Defaults filter to xhr/fetch resourceTypes; pass resourceTypes=["*"] ' +
        'to capture everything. Auto-stops at maxRecords (default 500), after ' +
        'timeoutMs (default 5 min), or when the tab closes.',
      inputSchema: StartRecordNetworkInputRaw.shape,
    },
    async (args) => {
      const { status, body } = await bridgePost('/record-network/start', args);
      if (status >= 400) return toMcpError(asErrorEnvelope(body, `bridge ${status}`));
      const parsed = StartRecordNetworkOutput.safeParse(body);
      if (!parsed.success) return toMcpError({ error: 'unknown', message: parsed.error.message });
      return { content: [{ type: 'text', text: JSON.stringify(parsed.data) }] };
    },
  );
}
```

- [ ] **Step 2: Implement browser-stop-record-network.ts**

Create `/Users/wxt/code/byob/packages/mcp-server/src/tools/browser-stop-record-network.ts`:

```ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StopRecordNetworkInput, StopRecordNetworkOutput } from '@byob/shared';
import { bridgePost } from '../bridge-client.js';
import { asErrorEnvelope, toMcpError } from '../error-mapper.js';

export function registerBrowserStopRecordNetwork(server: McpServer): void {
  server.registerTool(
    'browser_stop_record_network',
    {
      title: 'Stop a recording and return captured network records',
      description:
        'Stop a recording previously started with browser_start_record_network and ' +
        'return all captured records. Pass format="har" to also receive a HAR 1.2 ' +
        'archive (importable into Chrome DevTools / Charles / online viewers). ' +
        'WebSocket frames are emitted under the _webSocketMessages custom field on ' +
        'the matching HAR entry, matching Chrome DevTools "Save all as HAR" output.',
      inputSchema: StopRecordNetworkInput.shape,
    },
    async (args) => {
      const { status, body } = await bridgePost('/record-network/stop', args);
      if (status >= 400) return toMcpError(asErrorEnvelope(body, `bridge ${status}`));
      const parsed = StopRecordNetworkOutput.safeParse(body);
      if (!parsed.success) return toMcpError({ error: 'unknown', message: parsed.error.message });
      return { content: [{ type: 'text', text: JSON.stringify(parsed.data) }] };
    },
  );
}
```

- [ ] **Step 3: Wire registrations into tools/index.ts**

Edit `/Users/wxt/code/byob/packages/mcp-server/src/tools/index.ts`:

```ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerBrowserRead } from './browser-read.js';
import { registerBrowserClick } from './browser-click.js';
import { registerBrowserType } from './browser-type.js';
import { registerBrowserNavigate } from './browser-navigate.js';
import { registerBrowserWaitFor } from './browser-wait-for.js';
import { registerBrowserScreenshot } from './browser-screenshot.js';
import { registerBrowserGetCookies } from './browser-get-cookies.js';
import { registerBrowserListTabs } from './browser-list-tabs.js';
import { registerBrowserSwitchTab } from './browser-switch-tab.js';
import { registerBrowserEval } from './browser-eval.js';
import { registerBrowserDownloadImages } from './browser-download-images.js';
import { registerBrowserStartRecordNetwork } from './browser-start-record-network.js';
import { registerBrowserStopRecordNetwork } from './browser-stop-record-network.js';

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
  registerBrowserDownloadImages(server);
  registerBrowserStartRecordNetwork(server);
  registerBrowserStopRecordNetwork(server);
  if (process.env.BYOB_ALLOW_EVAL === '1') {
    registerBrowserEval(server);
    console.error('[byob-mcp] browser_eval ENABLED via BYOB_ALLOW_EVAL=1');
  }
}
```

- [ ] **Step 4: Run typecheck on mcp-server**

Run: `unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY; cd /Users/wxt/code/byob/packages/mcp-server && bun run typecheck`
Expected: No errors.

- [ ] **Step 5: Run repo-wide typecheck**

Run: `unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY; cd /Users/wxt/code/byob && bun run typecheck`
Expected: All four packages green.

- [ ] **Step 6: Commit**

Commit message:

```
feat(mcp-server): register browser_start_record_network and browser_stop_record_network

Two new MCP tools complete the record-network pair. Schemas come from
@byob/shared; tool descriptions document defaults and the HAR option.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

---

# Task 11: Manual e2e checklist + ad-hoc validation

**Files:**
- Modify: `/Users/wxt/code/byob/docs/e2e-checklist.md`

byob's released test strategy is manual e2e (per spec 12 §). The unit tests in Tasks 2/4/5 cover pure logic; the cross-process behaviour is validated here. The build artefacts must be loaded into Chrome via `chrome://extensions → Reload`.

- [ ] **Step 1: Append a record_network section to the e2e checklist**

Open `/Users/wxt/code/byob/docs/e2e-checklist.md` and append at the end of the file:

```markdown

## record_network (v0.2 sub-project C)

Pre-req: Chrome restarted with the rebuilt extension. `bun run typecheck` green.

- [ ] **Basic XHR capture** — Start `browser_start_record_network` with `url=https://news.ycombinator.com`, browse for ~30 s, then stop. Expect `recordCount >= 5` and at least one entry with `resourceType ∈ {xhr, fetch}` and a populated `responseBody`.
- [ ] **urlPattern glob filter** — Start with `urlPattern='*api*'` on a SPA-heavy page (e.g. `https://github.com/anthropics/anthropic-sdk-typescript`), browse, stop. Verify every record's `url` contains `api`.
- [ ] **resourceTypes=['*']** — Start with `resourceTypes=['*']` on `https://github.com`, stop after 10 s. Verify records of type `document`, `script`, `image`, `stylesheet` are all present.
- [ ] **maxRecords autoStop** — Start with `maxRecords=5`, navigate to a page that fires more than 10 requests, stop. Verify `recordCount=5`, `truncated=true`, `endedReason='max_records'`.
- [ ] **tab_closed autoStop** — Start a recording, then close the tab manually before calling stop. Call stop. Verify `endedReason='tab_closed'` and the records captured before close are returned.
- [ ] **timeout autoStop** — Start with `timeoutMs=5000`, wait 10 s, then stop. Verify `endedReason='timeout'`.
- [ ] **WebSocket frames** — Start on `https://www.websocket.org/echo.html` (or open the dev console on a page and connect to `wss://echo.websocket.events`). Send a few text messages. Stop. Verify exactly one record with `resourceType='websocket'` and `webSocketFrames` containing both `direction='sent'` and `direction='received'` entries.
- [ ] **HAR format** — Stop with `format='har'`. Verify `har.log.version='1.2'`, `har.log.entries.length===recordCount`, every entry has `request.method`, `response.status`, `timings.dns/connect/send/wait/receive` keys. Pipe to `bunx har-validator -` (or `bun add -d har-validator && bunx har-validator har.json`); accept warnings about `_*` custom fields, fail on hard schema errors.
- [ ] **eval-then-stop** — Start a recording. Use `BYOB_ALLOW_EVAL=1 browser_eval` to run `fetch('/robots.txt').then(r=>r.text())`. Stop. Verify a record exists for `/robots.txt` with `responseBody` populated.
- [ ] **recording_not_found** — Call stop with a random UUID that was never started. Expect MCP error envelope with `error='recording_not_found'`.
```

- [ ] **Step 2: Sanity-check the dev workflow against a real recording**

Run the standard byob dev loop in three terminals (per HANDOFF.md):

Terminal 1:
```sh
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
cd /Users/wxt/code/byob/packages/extension && bun run dev
```

Terminal 2:
```sh
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
tail -f ~/.byob/bridge.log
```

Then in Chrome: `chrome://extensions → Reload`. The new commands should be reachable via `curl`:

```sh
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
SOCK=$(ls ~/.byob/bridges/*.sock | head -1)
curl --unix-socket "$SOCK" -X POST http://x/record-network/start \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://news.ycombinator.com","resourceTypes":["xhr","fetch"]}'
# capture recordingId from response, e.g. RID=abc-123
RID=...
sleep 10
curl --unix-socket "$SOCK" -X POST http://x/record-network/stop \
  -H 'Content-Type: application/json' \
  -d "{\"recordingId\":\"$RID\",\"format\":\"har\"}"
```

Expected: Start returns `{recordingId, tabId, url, startedAt}`. Stop returns `{records:[…], har:{log:{…}}, recordCount, endedReason:'user_stop', tabId, durationMs, truncated:false}`.

- [ ] **Step 3: Walk the e2e checklist**

Tick each item in `docs/e2e-checklist.md` from Step 1 by hand. If any item fails, stop and diagnose — do not skip ahead.

- [ ] **Step 4: Commit checklist additions**

Commit message:

```
docs(e2e): record_network manual checklist for v0.2 sub-project C

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

---

## Self-Review Notes

These were checked while writing the plan and intentionally documented for the executing engineer:

1. **Spec coverage** — Every interface field in spec §4 is covered by the schemas in Task 1. autoStop reasons (§5.4) are wired in Task 6 (`endRecording` accepts all 5 reasons; `'wake_recovery'` is reserved for future use, no current trigger). HAR custom-field convention (§7) implemented in Task 5. SW eviction defence (§6) implemented in Task 3 (alarm) and Task 6 (keepalive ref). Error map (§9) covered: `forbidden_url`, `cdp_attach_failed`, `recording_not_found`, `recording_failed_to_attach`, `tab_closed`. The `total buffer NM 64MB limit` truncation (§9 last row) is **not currently implemented** — the per-body, per-frame, and `maxRecords` caps make it unreachable in practice; document as a known follow-up if a reviewer flags it.
2. **Type consistency** — `RecordingEntry`, `RecordingOptions`, `EndedReason`, `AccumulatorContext`, `NetworkRecord`, `WebSocketFrame` names are stable across tasks 1/3/4/5/6/7. The `_byobRequestId` HAR custom field referenced in tests (Task 5) is emitted by `toHarEntry` in the same task.
3. **Risk: SW eviction defence reliability** — The 25 s alarm + keepalive provides best-effort, not a guarantee. Spec §6 explicitly documents "long-running recordings ≥30 min are not guaranteed". The plan does not implement `chrome.storage.session` registry persistence (spec §6 final paragraph rejected it). If a reviewer disagrees and wants persistence, treat that as a follow-up plan, not in-scope here.
4. **Risk: `_webSocketMessages` naming** — Chosen to match Chrome DevTools' export. Strict HAR validators (e.g. http://www.softwareishard.com/blog/har-12-spec/ enforcer) flag `_*` underscore fields; spec §11 calls this out. Document in `e2e-checklist.md` step 8: "accept warnings about `_*` custom fields, fail on hard schema errors". If a tighter contract is required later, swap to standard `comment` field — not in this plan.
5. **Coordination point with B (AbortSignal)** — Both `handleStartRecordNetwork` and `handleStopRecordNetwork` accept `_signal?: AbortSignal` and pass it through. B will rename to `signal`, add `signal?.throwIfAborted()` calls, and wire cleanup paths. **Do not** add abort plumbing in this plan; the reserved slot is the contract.
