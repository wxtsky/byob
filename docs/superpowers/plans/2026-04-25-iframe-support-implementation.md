# D iframe Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add cross-frame (iframe / OOPIF) addressing to nine byob tools by introducing a `framePath: string[]` parameter that resolves to a CDP execution context, while keeping the default (main-frame) behavior bit-for-bit compatible.

**Architecture:** A new `FramePathInput` mixin extends 9 input schemas with optional `framePath`. `cdp.attach()` is upgraded to call `Target.setAutoAttach({autoAttach:true, waitForDebuggerOnStart:false, flatten:true})` so child frames (including cross-origin OOPIFs) become addressable through the same `chrome.debugger` session via `sessionId`. A new `lib/frame-resolver.ts` walks the `framePath` array (querySelector → `DOM.describeNode` → `Page.getFrameTree` → `Runtime.executionContextCreated`) and returns `{ frameId, contextId, sessionId? }`. A new `lib/frame-coords.ts` accumulates iframe-element bounding rects so `Input.dispatchMouseEvent` (which is page-level) can be called with correct global coordinates for clicks/typing inside nested frames.

**Tech Stack:** TypeScript strict · Chrome DevTools Protocol (`Target.setAutoAttach flatten`, `Page.getFrameTree`, `DOM.describeNode`, `Runtime.evaluate {contextId}`) · `chrome.debugger` MV3 API · Zod (schema mixin) · bun:test (unit tests for resolver / coords)

**Spec reference:** `/Users/wxt/code/byob/docs/superpowers/specs/2026-04-25-iframe-support-design.md`

---

## Cross-project coordination

This plan assumes implementation order **A → C → D → B**:

- **Sub-project A** (console_logs / read_markdown / extract_table) is implemented BEFORE D. Its three handler files at `packages/extension/lib/handlers/{get-console-logs,read-markdown,extract-table}.ts` and matching schemas already exist when D starts. D **modifies** these — it does NOT create them.
- **Sub-project C** (record_network) is tab-level and does not need framePath, so D never touches it.
- **Sub-project B** (AbortSignal end-to-end) runs AFTER D. D leaves a `signal?: AbortSignal` parameter slot in new function signatures (typed but unused) so B can wire it without re-shaping every call site.

If A is *not* yet implemented when this plan runs, Tasks 6, 7, 8 (the three A-handler edits) become no-ops. The plan still works for the six v0.1 handlers without those tasks.

## File Structure (locked in by this plan)

```
byob/
├── shared/src/
│   ├── schemas.ts                                  # Modify: extend 9 inputs with FramePathInput mixin
│   └── errors.ts                                   # Modify: add 4 frame_* error codes
└── packages/extension/lib/
    ├── cdp.ts                                      # Modify: enable Target.setAutoAttach flatten
    ├── frame-resolver.ts                           # Create: resolveFrame() + querySelectorInFrame()
    ├── frame-coords.ts                             # Create: toPageCoords()
    └── handlers/
        ├── read.ts                                 # Modify: framePath → Runtime.evaluate({contextId})
        ├── click.ts                                # Modify: framePath + page-level coords
        ├── type.ts                                 # Modify: framePath + page-level coords
        ├── eval.ts                                 # Modify: framePath → Runtime.evaluate({contextId})
        ├── wait-for.ts                             # Modify: framePath → observer in frame
        ├── download-images.ts                      # Modify: framePath → enumerate <img> in frame
        ├── read-markdown.ts            (A-built)   # Modify: framePath → outerHTML in frame
        ├── extract-table.ts            (A-built)   # Modify: framePath → tables in frame
        └── get-console-logs.ts         (A-built)   # Modify: filter by executionContextId

packages/extension/lib/__tests__/                   # Create: bun:test root
├── frame-resolver.test.ts                          # Create
└── frame-coords.test.ts                            # Create
```

Test files live in `__tests__/` siblings of the modules under test (matches WXT-friendly convention; bun:test auto-discovers `*.test.ts`).

---

## Task 1: Add FramePathInput schema mixin and frame_* error codes

**Files:**
- Modify: `/Users/wxt/code/byob/shared/src/schemas.ts`
- Modify: `/Users/wxt/code/byob/shared/src/errors.ts`

The shared schema package is the contract for all three other packages (extension / bridge / mcp-server). Extending it first means everything downstream type-checks against the new optional field with zero behavior change.

`FramePathInput` is a Zod object with one optional field, intentionally NOT defined as a `.refine()` or `.transform()` — handlers need to call `.extend()` on it, which only works on `ZodObject`. We re-export it raw and merge it into the 9 affected input schemas via `.extend(FramePathInput.shape)`.

- [ ] **Step 1: Add FramePathInput export at the top of schemas.ts**

Add immediately after the `// ---------- Common ----------` block (after `ChunkSchema` definition, before `// ---------- 1. browser_read ----------`):

```ts
// ---------- Common: framePath mixin ----------
// Optional cross-frame addressing for tools that operate inside a specific
// iframe / nested frame. Each entry is a CSS selector matched against the
// current frame's document; the matched element must be an <iframe> or
// <frame>. An empty array (or omitted field) targets the main frame and
// preserves v0.1 behavior. See spec `2026-04-25-iframe-support-design.md`.
export const FramePathInput = z.object({
  framePath: z.array(z.string().min(1)).max(8).default([]),
});
```

`max(8)` is a defensive cap — eight nested iframes is already pathological, anything more is almost certainly user error.

- [ ] **Step 2: Extend the 9 affected input schemas**

Replace each schema block listed below. Each one becomes `<existing>.merge(FramePathInput)`. The full list:

`ReadInput` (line ~15):

```ts
export const ReadInput = z.object({
  url: z.string().url(),
  screens: z.number().int().min(1).max(50).default(3),
  timeoutSec: z.number().int().min(1).max(600).default(60),
  sessionId: z.string().optional(),
  reuseTab: z.boolean().default(false),
}).merge(FramePathInput);
```

`ClickInput` (line ~49):

```ts
export const ClickInput = z.object({
  selector: z.string(),
  tabId: z.number().int().optional(),
  button: z.enum(['left', 'right', 'middle']).default('left'),
  clickCount: z.number().int().min(1).max(3).default(1),
  modifiers: z.array(z.enum(['Alt', 'Control', 'Shift', 'Meta'])).default([]),
}).merge(FramePathInput);
```

`TypeInput` (line ~62):

```ts
export const TypeInput = z.object({
  selector: z.string(),
  text: z.string(),
  tabId: z.number().int().optional(),
  clear: z.boolean().default(false),
  pressEnter: z.boolean().default(false),
}).merge(FramePathInput);
```

`EvalInput` (line ~98):

```ts
export const EvalInput = z.object({
  code: z.string(),
  tabId: z.number().int().optional(),
  awaitPromise: z.boolean().default(true),
  returnByValue: z.boolean().default(true),
}).merge(FramePathInput);
```

`WaitForInput` (line ~126):

```ts
export const WaitForInput = z.object({
  selector: z.string(),
  tabId: z.number().int().optional(),
  state: z.enum(['visible', 'hidden', 'attached', 'detached']).default('visible'),
  timeoutSec: z.number().int().min(1).max(600).default(10),
}).merge(FramePathInput);
```

`DownloadImagesInput` (line ~155):

```ts
export const DownloadImagesInput = z.object({
  url: z.string().url(),
  saveDir: z.string().optional(),
  reuseTab: z.boolean().default(false),
  screens: z.number().int().min(0).max(50).default(5),
  timeoutSec: z.number().int().min(1).max(600).default(120),
  maxImages: z.number().int().min(1).max(500).default(50),
  minWidth: z.number().int().min(0).default(100),
  minHeight: z.number().int().min(0).default(100),
  includeOgImage: z.boolean().default(true),
}).merge(FramePathInput);
```

For the three A-built schemas (`ReadMarkdownInput`, `ExtractTableInput`, `GetConsoleLogsInput`), append `.merge(FramePathInput)` to their existing `z.object({...})` literal in the same file. Locate each by name and apply identically. If any of those three schemas is not yet present (sub-project A not implemented), skip the missing ones — a follow-up commit when A lands will add the merge.

- [ ] **Step 3: Add 4 frame error codes to errors.ts**

Replace the existing `ErrorCode` const block (entire file lines 1-17) with:

```ts
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
  // iframe / cross-frame addressing
  FRAME_NOT_FOUND:               'frame_not_found',
  FRAME_NAVIGATION_DURING_OP:    'frame_navigation_during_op',
  FRAME_ATTACH_FAILED:           'frame_attach_failed',
  FRAME_EVAL_BLOCKED:            'frame_eval_blocked',
  UNKNOWN:                 'unknown',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface ErrorEnvelope {
  error: ErrorCodeValue;
  message: string;
  hint?: string;
  aborted?: boolean;
  /** When error === 'frame_not_found', the failing index in framePath (0-based). */
  framePathIndex?: number;
  /** Free-form sub-reason for frame_* errors: 'not_an_iframe' | 'frame_blank' | 'flatten_unsupported' | etc. */
  reason?: string;
}
```

- [ ] **Step 4: Verify shared package type-checks**

Run:

```bash
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
bun --cwd /Users/wxt/code/byob/shared run typecheck
```

Expected: exit code 0, no output (or just `tsc --noEmit` line). The new `FramePathInput` is purely additive; existing schemas merge with it without breaking inference because all merged fields are optional with defaults.

- [ ] **Step 5: Verify root workspace still type-checks**

Run:

```bash
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
bun --cwd /Users/wxt/code/byob run typecheck
```

Expected: all four packages green. Existing handler `parse(rawParams)` calls already implicitly accept the new field because Zod allows unknown keys to pass through `.parse` only when the schema doesn't `.strict()` — these don't, so the new optional field just becomes available on the parsed result with default `[]`.

- [ ] **Step 6: Commit**

```
feat(shared): add FramePathInput mixin and frame_* error codes

- New optional `framePath: string[]` (default []) on 9 input schemas:
  read, click, type, eval, wait-for, download-images, plus the
  three A-introduced handlers (read-markdown / extract-table /
  get-console-logs) when present.
- Four new error codes: frame_not_found, frame_navigation_during_op,
  frame_attach_failed, frame_eval_blocked.
- ErrorEnvelope grows optional `framePathIndex` + `reason` for
  callers to pinpoint which selector in the path failed.
- Behavior: empty/omitted framePath = main frame, fully backward
  compatible with v0.1 clients.
```

---

## Task 2: Enable flatten auto-attach in cdp.ts

**Files:**
- Modify: `/Users/wxt/code/byob/packages/extension/lib/cdp.ts:29-55`

CDP `Target.setAutoAttach({flatten: true})` is the load-bearing primitive. With it, the parent `chrome.debugger` session automatically receives commands and events for *all* descendant frames, including cross-origin out-of-process iframes (OOPIFs). Without it, OOPIFs are unreachable through the parent session — you'd have to attach to each child target separately, which `chrome.debugger` does not let MV3 extensions do directly.

`flatten:true` means events arrive on the parent session with a `sessionId` field identifying the originating child target, rather than as a wrapped envelope. Chrome ≥78 supports it.

- [ ] **Step 1: Change attach() to enable flatten autoAttach**

Open `/Users/wxt/code/byob/packages/extension/lib/cdp.ts`. Replace lines 29-55 (the `async attach(): Promise<boolean>` method body) with:

```ts
  async attach(): Promise<boolean> {
    if (this.attached) return true;
    let lastErr: unknown;
    for (let i = 0; i < ATTACH_MAX_RETRIES; i++) {
      try {
        await chrome.debugger.attach({ tabId: this.tabId }, ATTACH_VERSION);
        this.attached = true;
        // Useful baseline: enable Runtime, opt into focus emulation so
        // background tabs work.
        await this.send('Runtime.enable', {});
        // Flatten auto-attach: parent session transparently receives traffic
        // for all child frames (including cross-origin OOPIFs) addressed via
        // the `sessionId` field. Required for cross-frame addressing.
        try {
          await this.send('Target.setAutoAttach', {
            autoAttach: true,
            waitForDebuggerOnStart: false,
            flatten: true,
          });
        } catch (e) {
          // Older Chrome (< 78) lacks flatten. Detach and surface a clear
          // reason so callers can show the user a useful hint.
          console.warn('[byob/cdp] Target.setAutoAttach flatten unsupported:', e);
          await chrome.debugger.detach({ tabId: this.tabId }).catch(() => {});
          this.attached = false;
          throw new Error('flatten_unsupported');
        }
        try {
          await this.send('Emulation.setFocusEmulationEnabled', { enabled: true });
        } catch {
          // not all targets support this; non-fatal
        }
        return true;
      } catch (e) {
        lastErr = e;
        if (i < ATTACH_MAX_RETRIES - 1) {
          await new Promise((r) => setTimeout(r, ATTACH_BACKOFF_MS * (i + 1)));
        }
      }
    }
    console.warn('[byob/cdp] attach failed after retries', this.tabId, lastErr);
    this.attached = false;
    return false;
  }
```

- [ ] **Step 2: Add a public helper to sendCommand on a child sessionId**

Append the following method to the `CdpSession` class (immediately after the existing `evaluate()` method, before the closing `}` of the class):

```ts
  /**
   * Send a CDP command on a flatten-attached child session (OOPIF).
   * The `sessionId` is what `Target.attachedToTarget` events delivered.
   * For same-origin frames just use `send()`.
   */
  sendOnSession<T = unknown>(
    sessionId: string,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      chrome.debugger.sendCommand(
        { tabId: this.tabId, sessionId } as chrome.debugger.Debuggee,
        method,
        params,
        (res?: unknown) => {
          const err = chrome.runtime.lastError;
          if (err) reject(new Error(err.message ?? `CDP ${method} failed (sess ${sessionId})`));
          else resolve(res as T);
        },
      );
    });
  }
```

`chrome.debugger.Debuggee` may not declare `sessionId` in the typing bundle currently in use; the cast keeps strict mode happy. The runtime accepts it because Chrome forwards everything in `Debuggee` to `Target.dispatchCommand` under the hood when flatten is on.

- [ ] **Step 3: Type-check the extension package**

Run:

```bash
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
bun --cwd /Users/wxt/code/byob/packages/extension run typecheck
```

Expected: exit code 0. If `chrome.debugger.Debuggee` typing rejects the cast, retain the `as chrome.debugger.Debuggee` — strict mode requires it but the runtime field is accepted.

- [ ] **Step 4: Commit**

```
feat(extension/cdp): enable Target.setAutoAttach flatten + sessionId helper

- `attach()` now turns on flatten auto-attach so the parent debugger
  session transparently receives traffic for all descendant frames,
  including out-of-process iframes (OOPIFs).
- On Chrome < 78 (no flatten support) we detach and throw
  'flatten_unsupported' so callers can return a precise error.
- Add `CdpSession.sendOnSession(sessionId, method, params)` for
  routing CDP commands to a specific OOPIF target via its sessionId.
- No behavior change for tools that don't use framePath — they keep
  hitting the parent session as before.
```

---

## Task 3: Build frame-resolver with unit tests

**Files:**
- Create: `/Users/wxt/code/byob/packages/extension/lib/frame-resolver.ts`
- Create: `/Users/wxt/code/byob/packages/extension/lib/__tests__/frame-resolver.test.ts`

`resolveFrame(session, framePath)` walks the frame tree one selector at a time. Each step:

1. Run `Runtime.evaluate` in the *current* frame's `executionContextId` to query the iframe element by selector. Return the element's CDP `objectId` (so we can keep DOM-level identity).
2. Call `DOM.describeNode({objectId})` → its `frameId` field identifies which frame this iframe loads.
3. Walk `Page.getFrameTree()` to find the FrameTree node matching that `frameId` — that gives us the child frame's metadata.
4. Look up the executionContextId for the child frame. With flatten auto-attach, every frame fires `Runtime.executionContextCreated` on the parent session; we cache those. For OOPIFs the same event arrives but with a non-empty `sessionId` field.

Identity is then: `{frameId, contextId, sessionId?}`. `sessionId` is undefined for same-origin frames, populated for OOPIFs.

- [ ] **Step 1: Write the failing tests for frame-resolver**

Create `/Users/wxt/code/byob/packages/extension/lib/__tests__/frame-resolver.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'bun:test';
import { resolveFrame, _resetContextRegistryForTests } from '../frame-resolver.js';

// Minimal stub matching the subset of CdpSession we use. Tests pre-program
// `send()` to return canned values per (method, params). The third argument
// `_sessionId` is unused here — sessionId routing is exercised in
// 'OOPIF target via sessionId'.
type Call = { method: string; params: Record<string, unknown> };
function makeStubSession(scripts: Record<string, unknown[]>) {
  const calls: Call[] = [];
  const queue = new Map<string, unknown[]>(Object.entries(scripts));
  return {
    calls,
    send: async <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
      calls.push({ method, params });
      const q = queue.get(method);
      if (!q || q.length === 0) throw new Error(`stub missing for ${method}`);
      return q.shift() as T;
    },
    sendOnSession: async <T>(_sessionId: string, method: string, params: Record<string, unknown> = {}): Promise<T> => {
      calls.push({ method: `[${_sessionId}]${method}`, params });
      const q = queue.get(`[${_sessionId}]${method}`);
      if (!q || q.length === 0) throw new Error(`stub missing for [${_sessionId}]${method}`);
      return q.shift() as T;
    },
  };
}

beforeEach(() => {
  _resetContextRegistryForTests();
});

describe('resolveFrame', () => {
  it('returns main frame identity for empty framePath', async () => {
    const session = makeStubSession({
      'Page.getFrameTree': [{
        frameTree: { frame: { id: 'main-frame', url: 'https://a.test/' }, childFrames: [] },
      }],
    });
    // pre-seed registry: main frame contextId already known
    const { _seedContextForTests } = await import('../frame-resolver.js');
    _seedContextForTests('main-frame', { contextId: 1, sessionId: undefined });

    const out = await resolveFrame(session as never, []);
    expect(out).toEqual({ frameId: 'main-frame', contextId: 1, sessionId: undefined });
  });

  it('resolves single-level same-origin iframe', async () => {
    const session = makeStubSession({
      // step 1: query iframe in main frame
      'Runtime.evaluate': [
        { result: { objectId: 'iframe-obj-1', subtype: 'node' } },
      ],
      // step 2: describeNode → frameId
      'DOM.describeNode': [
        { node: { nodeName: 'IFRAME', frameId: 'child-frame', nodeId: 100 } },
      ],
      // step 3: getFrameTree to confirm child exists
      'Page.getFrameTree': [
        {
          frameTree: {
            frame: { id: 'main-frame', url: 'https://a.test/' },
            childFrames: [
              { frame: { id: 'child-frame', url: 'https://a.test/embed' }, childFrames: [] },
            ],
          },
        },
      ],
    });
    const { _seedContextForTests } = await import('../frame-resolver.js');
    _seedContextForTests('main-frame', { contextId: 1, sessionId: undefined });
    _seedContextForTests('child-frame', { contextId: 2, sessionId: undefined });

    const out = await resolveFrame(session as never, ['iframe[name="x"]']);
    expect(out).toEqual({ frameId: 'child-frame', contextId: 2, sessionId: undefined });
  });

  it('rejects when selector matches a non-iframe element', async () => {
    const session = makeStubSession({
      'Runtime.evaluate': [{ result: { objectId: 'div-obj' } }],
      'DOM.describeNode': [{ node: { nodeName: 'DIV', nodeId: 5 } }],
      'Page.getFrameTree': [{
        frameTree: { frame: { id: 'main-frame', url: 'https://a.test/' }, childFrames: [] },
      }],
    });
    const { _seedContextForTests } = await import('../frame-resolver.js');
    _seedContextForTests('main-frame', { contextId: 1, sessionId: undefined });

    await expect(resolveFrame(session as never, ['div.foo'])).rejects.toMatchObject({
      error: 'frame_not_found',
      framePathIndex: 0,
      reason: 'not_an_iframe',
    });
  });

  it('rejects when selector matches nothing (frame_not_found, index 0)', async () => {
    const session = makeStubSession({
      'Runtime.evaluate': [{ result: { value: null, type: 'object' } }],
      'Page.getFrameTree': [{
        frameTree: { frame: { id: 'main-frame', url: 'https://a.test/' }, childFrames: [] },
      }],
    });
    const { _seedContextForTests } = await import('../frame-resolver.js');
    _seedContextForTests('main-frame', { contextId: 1, sessionId: undefined });

    await expect(resolveFrame(session as never, ['#nope'])).rejects.toMatchObject({
      error: 'frame_not_found',
      framePathIndex: 0,
    });
  });

  it('reports correct index when nested step fails', async () => {
    const session = makeStubSession({
      'Runtime.evaluate': [
        // step 0: outer iframe found
        { result: { objectId: 'iframe-outer' } },
        // step 1: inner selector misses
        { result: { value: null, type: 'object' } },
      ],
      'DOM.describeNode': [
        { node: { nodeName: 'IFRAME', frameId: 'outer-frame', nodeId: 10 } },
      ],
      'Page.getFrameTree': [
        {
          frameTree: {
            frame: { id: 'main-frame', url: 'https://a.test/' },
            childFrames: [{ frame: { id: 'outer-frame', url: 'https://a.test/o' }, childFrames: [] }],
          },
        },
        // second call after outer step also returns the same tree
        {
          frameTree: {
            frame: { id: 'main-frame', url: 'https://a.test/' },
            childFrames: [{ frame: { id: 'outer-frame', url: 'https://a.test/o' }, childFrames: [] }],
          },
        },
      ],
    });
    const { _seedContextForTests } = await import('../frame-resolver.js');
    _seedContextForTests('main-frame', { contextId: 1, sessionId: undefined });
    _seedContextForTests('outer-frame', { contextId: 2, sessionId: undefined });

    await expect(resolveFrame(session as never, ['iframe.outer', 'iframe.inner'])).rejects.toMatchObject({
      error: 'frame_not_found',
      framePathIndex: 1,
    });
  });

  it('routes via sessionId for OOPIF targets', async () => {
    const session = makeStubSession({
      // outer iframe lookup happens on main session
      'Runtime.evaluate': [{ result: { objectId: 'iframe-x' } }],
      'DOM.describeNode': [{ node: { nodeName: 'IFRAME', frameId: 'oopif-frame', nodeId: 7 } }],
      'Page.getFrameTree': [
        {
          frameTree: {
            frame: { id: 'main-frame', url: 'https://a.test/' },
            childFrames: [{ frame: { id: 'oopif-frame', url: 'https://other.test/' }, childFrames: [] }],
          },
        },
      ],
    });
    const { _seedContextForTests } = await import('../frame-resolver.js');
    _seedContextForTests('main-frame', { contextId: 1, sessionId: undefined });
    _seedContextForTests('oopif-frame', { contextId: 99, sessionId: 'sess-oopif' });

    const out = await resolveFrame(session as never, ['iframe[src*="other"]']);
    expect(out).toEqual({ frameId: 'oopif-frame', contextId: 99, sessionId: 'sess-oopif' });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
bun test /Users/wxt/code/byob/packages/extension/lib/__tests__/frame-resolver.test.ts
```

Expected: all 6 tests FAIL with "Cannot find module '../frame-resolver.js'" (file does not exist yet).

- [ ] **Step 3: Implement frame-resolver.ts**

Create `/Users/wxt/code/byob/packages/extension/lib/frame-resolver.ts`:

```ts
/**
 * Frame addressing across same-origin iframes and OOPIFs.
 *
 * Walks a `framePath: string[]` of CSS selectors level-by-level:
 *   selector_i is matched in the document of the frame resolved at step i-1.
 *
 * Returns `{ frameId, contextId, sessionId? }` — the executionContextId is
 * what `Runtime.evaluate` needs to run code in the right frame, and
 * `sessionId` (when present) routes the command to an OOPIF child target
 * via flatten auto-attach.
 *
 * The execution-context registry is populated by listeners installed in
 * `entrypoints/background.ts` that subscribe to
 * `Runtime.executionContextCreated` / `Runtime.executionContextDestroyed`
 * events. For unit tests the registry can be seeded directly via
 * `_seedContextForTests`.
 */

import type { ErrorEnvelope } from '@byob/shared';

export interface ResolvedFrame {
  frameId: string;
  contextId: number;
  sessionId?: string;
}

export class FrameError extends Error implements ErrorEnvelope {
  error: ErrorEnvelope['error'];
  framePathIndex?: number;
  reason?: string;
  hint?: string;
  constructor(env: ErrorEnvelope) {
    super(env.message);
    this.error = env.error;
    this.framePathIndex = env.framePathIndex;
    this.reason = env.reason;
    this.hint = env.hint;
  }
}

interface FrameTreeNode {
  frame: { id: string; url: string; parentId?: string };
  childFrames?: FrameTreeNode[];
}
interface GetFrameTreeResult {
  frameTree: FrameTreeNode;
}
interface DescribeNodeResult {
  node: { nodeName: string; frameId?: string; nodeId: number };
}
interface EvalResult {
  result?: { objectId?: string; value?: unknown; type?: string };
}

interface SessionLike {
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  sendOnSession<T = unknown>(
    sessionId: string,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T>;
}

// (frameId) -> contextId / sessionId. Populated from
// Runtime.executionContextCreated events in background.ts.
const contextRegistry = new Map<string, { contextId: number; sessionId?: string }>();

export function recordContext(
  frameId: string,
  contextId: number,
  sessionId?: string,
): void {
  contextRegistry.set(frameId, { contextId, sessionId });
}

export function forgetContext(frameId: string): void {
  contextRegistry.delete(frameId);
}

/** Test-only seed; in production `recordContext` is called from event listeners. */
export function _seedContextForTests(
  frameId: string,
  v: { contextId: number; sessionId?: string },
): void {
  contextRegistry.set(frameId, v);
}

/** Test-only reset between tests. */
export function _resetContextRegistryForTests(): void {
  contextRegistry.clear();
}

function findFrameInTree(tree: FrameTreeNode, frameId: string): FrameTreeNode | null {
  if (tree.frame.id === frameId) return tree;
  for (const child of tree.childFrames ?? []) {
    const found = findFrameInTree(child, frameId);
    if (found) return found;
  }
  return null;
}

/**
 * Wrap an eval in the given context. Routes via sessionId for OOPIFs.
 */
async function evaluateInFrame<T>(
  session: SessionLike,
  ctx: { contextId: number; sessionId?: string },
  expression: string,
): Promise<T> {
  const params = { contextId: ctx.contextId, expression, returnByValue: false };
  const res = ctx.sessionId
    ? await session.sendOnSession<EvalResult>(ctx.sessionId, 'Runtime.evaluate', params)
    : await session.send<EvalResult>('Runtime.evaluate', params);
  return res.result as unknown as T;
}

export async function resolveFrame(
  session: SessionLike,
  framePath: string[],
): Promise<ResolvedFrame> {
  const tree = (await session.send<GetFrameTreeResult>('Page.getFrameTree')).frameTree;
  const mainFrameId = tree.frame.id;
  const mainCtx = contextRegistry.get(mainFrameId);
  if (!mainCtx) {
    throw new FrameError({
      error: 'frame_attach_failed',
      message: `No execution context known for main frame ${mainFrameId}`,
      hint: 'CDP autoAttach may not have fired yet — retry once.',
    });
  }

  let currentCtx = mainCtx;
  let currentFrameId = mainFrameId;

  for (let i = 0; i < framePath.length; i++) {
    const selector = framePath[i]!;
    // Step 1: find iframe element in current frame.
    const expr = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      return el || null;
    })()`;
    const found = (currentCtx.sessionId
      ? await session.sendOnSession<EvalResult>(currentCtx.sessionId, 'Runtime.evaluate', {
          contextId: currentCtx.contextId,
          expression: expr,
          returnByValue: false,
        })
      : await session.send<EvalResult>('Runtime.evaluate', {
          contextId: currentCtx.contextId,
          expression: expr,
          returnByValue: false,
        })) as EvalResult;
    const objectId = found.result?.objectId;
    if (!objectId) {
      throw new FrameError({
        error: 'frame_not_found',
        message: `framePath[${i}] selector ${JSON.stringify(selector)} matched no element`,
        framePathIndex: i,
      });
    }

    // Step 2: describe the node — this gives us the frame the iframe loads.
    const describeParams = { objectId };
    const describe = currentCtx.sessionId
      ? await session.sendOnSession<DescribeNodeResult>(
          currentCtx.sessionId,
          'DOM.describeNode',
          describeParams,
        )
      : await session.send<DescribeNodeResult>('DOM.describeNode', describeParams);
    const tag = (describe.node.nodeName || '').toLowerCase();
    if (tag !== 'iframe' && tag !== 'frame') {
      throw new FrameError({
        error: 'frame_not_found',
        message: `framePath[${i}] selector matched <${tag}>, expected <iframe>/<frame>`,
        framePathIndex: i,
        reason: 'not_an_iframe',
      });
    }
    const childFrameId = describe.node.frameId;
    if (!childFrameId) {
      throw new FrameError({
        error: 'frame_not_found',
        message: `framePath[${i}]: iframe element has no loaded frame (about:blank?)`,
        framePathIndex: i,
        reason: 'frame_blank',
      });
    }

    // Step 3: confirm childFrameId exists in the frame tree under currentFrameId.
    const refreshedTree = (await session.send<GetFrameTreeResult>('Page.getFrameTree')).frameTree;
    const node = findFrameInTree(refreshedTree, childFrameId);
    if (!node) {
      throw new FrameError({
        error: 'frame_navigation_during_op',
        message: `framePath[${i}]: frame ${childFrameId} disappeared from tree`,
        framePathIndex: i,
      });
    }

    // Step 4: look up the child frame's execution context.
    const childCtx = contextRegistry.get(childFrameId);
    if (!childCtx) {
      throw new FrameError({
        error: 'frame_attach_failed',
        message: `framePath[${i}]: no executionContext recorded for frame ${childFrameId}`,
        framePathIndex: i,
        hint: 'For OOPIFs this can race the autoAttach event — retry once.',
      });
    }

    currentCtx = childCtx;
    currentFrameId = childFrameId;
  }

  return {
    frameId: currentFrameId,
    contextId: currentCtx.contextId,
    sessionId: currentCtx.sessionId,
  };
}

/** Convenience: evaluate an expression in the resolved frame. */
export async function evaluateInResolvedFrame<T = unknown>(
  session: SessionLike,
  frame: ResolvedFrame,
  expression: string,
  opts: { awaitPromise?: boolean; returnByValue?: boolean } = {},
): Promise<T> {
  const params = {
    contextId: frame.contextId,
    expression,
    awaitPromise: opts.awaitPromise ?? true,
    returnByValue: opts.returnByValue ?? true,
  };
  const res = (frame.sessionId
    ? await session.sendOnSession<{ result: { value?: T }; exceptionDetails?: unknown }>(
        frame.sessionId,
        'Runtime.evaluate',
        params,
      )
    : await session.send<{ result: { value?: T }; exceptionDetails?: unknown }>(
        'Runtime.evaluate',
        params,
      )) as { result: { value?: T }; exceptionDetails?: unknown };
  if (res.exceptionDetails) {
    throw new FrameError({
      error: 'eval_exception',
      message: `eval threw in frame ${frame.frameId}: ${JSON.stringify(res.exceptionDetails).slice(0, 300)}`,
    });
  }
  return res.result?.value as T;
}
```

- [ ] **Step 4: Re-run the tests**

Run:

```bash
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
bun test /Users/wxt/code/byob/packages/extension/lib/__tests__/frame-resolver.test.ts
```

Expected: all 6 tests PASS. If a test fails because the FrameError instance comparison loses fields, double-check that `toMatchObject` is used (not `toEqual`) for the rejection assertions — `toMatchObject` matches partial fields on Error subclasses.

- [ ] **Step 5: Wire executionContext events from background.ts**

Open `/Users/wxt/code/byob/packages/extension/entrypoints/background.ts` and add these listeners *near the top* (after existing imports, before the dispatcher registration). If the file already has a `chrome.debugger.onEvent.addListener` call, augment it; otherwise add a new one:

```ts
import { recordContext, forgetContext } from '../lib/frame-resolver.js';

// Maintain (frameId) -> executionContextId/sessionId mapping by listening to
// Runtime.executionContextCreated / executionContextDestroyed events. Flatten
// auto-attach delivers these for every frame, including OOPIFs (with
// `sessionId` populated on the event source).
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (method === 'Runtime.executionContextCreated') {
    const p = params as { context?: { id?: number; auxData?: { frameId?: string } } } | undefined;
    const frameId = p?.context?.auxData?.frameId;
    const contextId = p?.context?.id;
    if (typeof frameId === 'string' && typeof contextId === 'number') {
      recordContext(frameId, contextId, source.sessionId);
    }
  } else if (method === 'Runtime.executionContextDestroyed') {
    // The destroyed event only carries executionContextId, not frameId.
    // For our purposes the next executionContextCreated for that frame
    // will overwrite, so this branch can be a no-op. We keep the symbol
    // imported for use if a future step needs it.
    void forgetContext;
  }
});
```

If `background.ts` already wraps these events for another reason, *add* the `recordContext` call inside the existing handler instead of duplicating the listener.

- [ ] **Step 6: Type-check**

Run:

```bash
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
bun --cwd /Users/wxt/code/byob/packages/extension run typecheck
```

Expected: green. The `chrome.debugger.DebuggerEventArgs` type may not declare `sessionId` on `Source` in the bundled `@types/chrome`; if strict mode complains, change the import line to:

```ts
import type { } from 'chrome-types'; // no-op, but pulls richer types if installed
```

If still complaining, use `(source as { sessionId?: string }).sessionId` at the call site.

- [ ] **Step 7: Commit**

```
feat(extension): frame-resolver — walk framePath to (frameId, contextId, sessionId)

- New `lib/frame-resolver.ts` with `resolveFrame(session, framePath)`
  that resolves CSS-selector chains across iframes including OOPIFs.
- Each step: querySelector in current context (Runtime.evaluate w/
  contextId) → DOM.describeNode → frameId → Page.getFrameTree
  validation → registry lookup of child executionContextId/sessionId.
- `recordContext` / `forgetContext` populated from Runtime
  executionContextCreated/Destroyed events emitted by flatten
  auto-attach (wired in background.ts).
- `FrameError` carries `framePathIndex` + `reason` so callers can
  build precise ErrorEnvelopes.
- 6 bun:test cases cover empty path, single level, nested miss,
  non-iframe selector, no-match selector, OOPIF sessionId routing.
```

---

## Task 4: Build frame-coords with unit tests

**Files:**
- Create: `/Users/wxt/code/byob/packages/extension/lib/frame-coords.ts`
- Create: `/Users/wxt/code/byob/packages/extension/lib/__tests__/frame-coords.test.ts`

`Input.dispatchMouseEvent` accepts page-level coordinates. When clicking inside nested iframes, we need to add the offset of every iframe element (in its parent frame) to the target element's frame-local rect.

`getBoundingClientRect()` on an iframe element returns the rect *as seen from the parent frame's viewport*, already accounting for that frame's CSS transforms (translation/scale — but not rotation; we accept that limitation per spec § 11). So the algorithm is just: walk the path, accumulate `(rect.x, rect.y)` of each iframe element measured in its parent frame.

The pure-math part (accumulating rectangles) is what we unit-test. The session interactions (querySelector / getBoundingClientRect) are stubbed.

- [ ] **Step 1: Write the failing tests**

Create `/Users/wxt/code/byob/packages/extension/lib/__tests__/frame-coords.test.ts`:

```ts
import { describe, it, expect } from 'bun:test';
import { _accumulateOffset } from '../frame-coords.js';

describe('_accumulateOffset (pure math)', () => {
  it('returns (0,0) for empty rect chain (main frame)', () => {
    const rects: Array<{ x: number; y: number }> = [];
    expect(_accumulateOffset(rects)).toEqual({ x: 0, y: 0 });
  });

  it('returns the rect itself for one iframe', () => {
    const rects = [{ x: 100, y: 200 }];
    expect(_accumulateOffset(rects)).toEqual({ x: 100, y: 200 });
  });

  it('sums offsets across nested iframes', () => {
    const rects = [
      { x: 50, y: 60 },     // outer iframe at (50,60) in main
      { x: 10, y: 20 },     // inner iframe at (10,20) in outer
    ];
    expect(_accumulateOffset(rects)).toEqual({ x: 60, y: 80 });
  });

  it('handles three levels', () => {
    const rects = [
      { x: 5, y: 5 },
      { x: 10, y: 10 },
      { x: 15, y: 15 },
    ];
    expect(_accumulateOffset(rects)).toEqual({ x: 30, y: 30 });
  });

  it('accepts negative offsets (iframe scrolled out of parent)', () => {
    const rects = [
      { x: -20, y: -30 },
      { x: 50, y: 60 },
    ];
    expect(_accumulateOffset(rects)).toEqual({ x: 30, y: 30 });
  });
});

describe('toPageCoords (with element rect)', () => {
  it('returns center of element + accumulated offset', async () => {
    // Mock collectIframeOffsets to return canned rects so this test stays
    // pure (no CDP session needed). We import via dynamic import so we can
    // stub the helper before the function under test reads it.
    const mod = await import('../frame-coords.js');
    const offsets = [{ x: 100, y: 200 }];
    const elementRect = { x: 30, y: 40, width: 20, height: 10 };
    const out = mod._composeFinalCoords(offsets, elementRect);
    // center: (30+10, 40+5) = (40, 45); + offset (100, 200) = (140, 245)
    expect(out).toEqual({ x: 140, y: 245 });
  });

  it('rounds to integer page pixels', () => {
    const offsets = [{ x: 100.7, y: 200.3 }];
    const elementRect = { x: 30.4, y: 40.6, width: 20, height: 10 };
    // offset 100.7 + 30.4 + 10 = 141.1 → 141 ; 200.3 + 40.6 + 5 = 245.9 → 246
    const out = require('../frame-coords.js')._composeFinalCoords(offsets, elementRect);
    expect(out).toEqual({ x: 141, y: 246 });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
bun test /Users/wxt/code/byob/packages/extension/lib/__tests__/frame-coords.test.ts
```

Expected: tests FAIL with "Cannot find module '../frame-coords.js'".

- [ ] **Step 3: Implement frame-coords.ts**

Create `/Users/wxt/code/byob/packages/extension/lib/frame-coords.ts`:

```ts
/**
 * Cross-frame coordinate translation for Input.dispatchMouseEvent.
 *
 * `Input.dispatchMouseEvent` is page-level; when clicking inside a nested
 * iframe, we need to add the offset of every iframe element (in its parent
 * frame's viewport) to the target element's local rect.
 *
 * `getBoundingClientRect()` on an iframe element accounts for CSS
 * translate/scale set on that iframe (or its ancestors in the parent
 * frame). It does NOT decompose 2D rotation; spec § 11 explicitly accepts
 * that limitation. For the rotation case, callers can fall back to
 * `eval` + `element.click()` synthetic event.
 *
 * IMPORTANT: every offset and the final element rect are measured in
 * VIEWPORT coordinates of their respective frame. We add the *viewport*
 * (x,y) of each iframe element. We do NOT add scroll position because
 * Input.dispatchMouseEvent expects viewport coordinates of the top-level
 * document (and child frames' scroll already affects their iframe element
 * positions in the parent).
 */

import type { ResolvedFrame } from './frame-resolver.js';

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface XY {
  x: number;
  y: number;
}

interface SessionLike {
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  sendOnSession<T = unknown>(
    sessionId: string,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T>;
}

/** Pure helper exported for unit tests. */
export function _accumulateOffset(rects: Array<{ x: number; y: number }>): XY {
  let x = 0;
  let y = 0;
  for (const r of rects) {
    x += r.x;
    y += r.y;
  }
  return { x, y };
}

/** Pure helper exported for unit tests. */
export function _composeFinalCoords(
  iframeOffsets: Array<{ x: number; y: number }>,
  elementRect: Rect,
): XY {
  const off = _accumulateOffset(iframeOffsets);
  return {
    x: Math.round(off.x + elementRect.x + elementRect.width / 2),
    y: Math.round(off.y + elementRect.y + elementRect.height / 2),
  };
}

/**
 * For a framePath chain like ['iframe.outer', 'iframe.inner'], walk each
 * level and return the iframe element's bounding rect in its *parent
 * frame's viewport*. Used by toPageCoords.
 *
 * NOTE: must be called BEFORE the page navigates / reflows; values are
 * snapshot at the moment of the call.
 */
async function collectIframeOffsets(
  session: SessionLike,
  framePath: string[],
  resolveFrameFn: (s: SessionLike, p: string[]) => Promise<ResolvedFrame>,
): Promise<Array<{ x: number; y: number }>> {
  const offsets: Array<{ x: number; y: number }> = [];
  // Walk each prefix [0..i] resolving the parent frame, then querying
  // the iframe selector at index i in that frame's context.
  for (let i = 0; i < framePath.length; i++) {
    const parentPath = framePath.slice(0, i);
    const parent = await resolveFrameFn(session, parentPath);
    const expr = `(() => {
      const el = document.querySelector(${JSON.stringify(framePath[i])});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    })()`;
    const params = {
      contextId: parent.contextId,
      expression: expr,
      returnByValue: true,
      awaitPromise: false,
    };
    const res = (parent.sessionId
      ? await session.sendOnSession<{ result: { value: Rect | null } }>(
          parent.sessionId,
          'Runtime.evaluate',
          params,
        )
      : await session.send<{ result: { value: Rect | null } }>('Runtime.evaluate', params)) as {
      result: { value: Rect | null };
    };
    const rect = res.result.value;
    if (!rect) {
      // resolveFrame would have already caught a missing iframe at this
      // step, but guard anyway in case of a race where the iframe was
      // detached between the two calls.
      throw new Error(`frame-coords: iframe element disappeared at framePath[${i}]`);
    }
    offsets.push({ x: rect.x, y: rect.y });
  }
  return offsets;
}

/**
 * Returns center-point page coordinates for an element inside a possibly
 * nested frame.
 *
 * @param elementSelector — CSS selector inside the *innermost* frame
 * @param frame           — the resolved innermost frame
 */
export async function toPageCoords(
  session: SessionLike,
  framePath: string[],
  frame: ResolvedFrame,
  elementSelector: string,
  resolveFrameFn: (s: SessionLike, p: string[]) => Promise<ResolvedFrame>,
): Promise<{ xy: XY; elementText: string } | null> {
  // 1. Get the element rect inside the innermost frame.
  const innerExpr = `(() => {
    const el = document.querySelector(${JSON.stringify(elementSelector)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, text: (el.innerText || '').slice(0, 200) };
  })()`;
  const innerParams = {
    contextId: frame.contextId,
    expression: innerExpr,
    returnByValue: true,
    awaitPromise: false,
  };
  const innerRes = (frame.sessionId
    ? await session.sendOnSession<{ result: { value: (Rect & { text: string }) | null } }>(
        frame.sessionId,
        'Runtime.evaluate',
        innerParams,
      )
    : await session.send<{ result: { value: (Rect & { text: string }) | null } }>(
        'Runtime.evaluate',
        innerParams,
      )) as { result: { value: (Rect & { text: string }) | null } };
  const inner = innerRes.result.value;
  if (!inner) return null;

  // 2. Walk framePath, summing iframe-element offsets.
  const offsets = await collectIframeOffsets(session, framePath, resolveFrameFn);

  // 3. Compose.
  const xy = _composeFinalCoords(offsets, inner);
  return { xy, elementText: inner.text };
}
```

- [ ] **Step 4: Re-run the tests**

Run:

```bash
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
bun test /Users/wxt/code/byob/packages/extension/lib/__tests__/frame-coords.test.ts
```

Expected: all 7 tests PASS.

- [ ] **Step 5: Type-check the extension package**

Run:

```bash
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
bun --cwd /Users/wxt/code/byob/packages/extension run typecheck
```

Expected: green.

- [ ] **Step 6: Commit**

```
feat(extension): frame-coords — page-level coords for nested iframes

- New `lib/frame-coords.ts` with `toPageCoords()` that walks a
  framePath, sums each iframe element's parent-frame viewport rect,
  and returns the click-target center in top-document coordinates.
- Pure helpers `_accumulateOffset` and `_composeFinalCoords` are
  exported for unit testing — 7 tests cover empty/single/nested
  paths plus rounding and negative offsets.
- Routes via sessionId for OOPIF iframes (parent context) so each
  bounding-rect query lands in the right target.
```

---

## Task 5: Update click + type handlers to use framePath

**Files:**
- Modify: `/Users/wxt/code/byob/packages/extension/lib/handlers/click.ts`
- Modify: `/Users/wxt/code/byob/packages/extension/lib/handlers/type.ts`

These are the two handlers that need *both* frame addressing AND coordinate translation. The pattern is:

1. Parse params (now includes `framePath`).
2. attachToTab as before.
3. `resolveFrame(session, framePath)` → frame identity.
4. For click: `toPageCoords(...)` — returns global coords.
5. For type: `evaluateInResolvedFrame` to focus + clear, then `Input.insertText`. `Input.insertText` is global to the page but routes to the focused element, so as long as focus succeeds in the inner frame, the text lands there.

We also map `FrameError` instances to `ErrorEnvelope` returns instead of letting them bubble as raw exceptions.

- [ ] **Step 1: Add a small helper to convert FrameError to envelope**

Append to the bottom of `/Users/wxt/code/byob/packages/extension/lib/frame-resolver.ts` (after `evaluateInResolvedFrame`):

```ts
/**
 * Centralized FrameError → ErrorEnvelope mapping. Returns null if the
 * thrown value is not a FrameError (caller should rethrow or wrap).
 */
export function frameErrorToEnvelope(e: unknown): {
  error: string;
  message: string;
  hint?: string;
  framePathIndex?: number;
  reason?: string;
} | null {
  if (e instanceof FrameError) {
    return {
      error: e.error,
      message: e.message,
      hint: e.hint,
      framePathIndex: e.framePathIndex,
      reason: e.reason,
    };
  }
  return null;
}
```

- [ ] **Step 2: Rewrite click.ts**

Replace the entire contents of `/Users/wxt/code/byob/packages/extension/lib/handlers/click.ts` with:

```ts
import { ClickInput } from '@byob/shared';
import { tryAttachToTab } from '../cdp.js';
import { resolveFrame, frameErrorToEnvelope } from '../frame-resolver.js';
import { toPageCoords } from '../frame-coords.js';

export async function handleClick(rawParams: unknown): Promise<unknown> {
  const params = ClickInput.parse(rawParams);

  const tabId = params.tabId ?? (await activeTabId());
  if (tabId === null) return { error: 'unknown', message: 'No active tab' };

  const { session, reason } = await tryAttachToTab(tabId);
  if (!session) {
    if (reason === 'special_page') {
      return {
        error: 'url_forbidden',
        message: 'Active tab is on a special page (chrome://, devtools://, etc.) — CDP cannot attach.',
        hint: 'Switch to a regular http(s):// tab.',
      };
    }
    if (reason === 'tab_gone') return { error: 'tab_closed', message: 'Tab was closed.' };
    return {
      error: 'cdp_attach_failed',
      message: 'Could not attach Chrome debugger after 3 retries.',
      hint: 'Close DevTools (F12) on the target tab and retry.',
    };
  }

  // Resolve frame chain. Empty framePath → main frame, behavior unchanged.
  let frame;
  try {
    frame = await resolveFrame(session, params.framePath);
  } catch (e) {
    const env = frameErrorToEnvelope(e);
    if (env) return env;
    throw e;
  }

  // Compute page-level coordinates: sum iframe offsets + element center.
  let coords;
  try {
    coords = await toPageCoords(session, params.framePath, frame, params.selector, resolveFrame);
  } catch (e) {
    const env = frameErrorToEnvelope(e);
    if (env) return env;
    throw e;
  }
  if (!coords) {
    return { error: 'selector_not_found', message: `No element matched ${params.selector}` };
  }

  const modifierMask = (() => {
    let m = 0;
    if (params.modifiers.includes('Alt')) m |= 1;
    if (params.modifiers.includes('Control')) m |= 2;
    if (params.modifiers.includes('Meta')) m |= 4;
    if (params.modifiers.includes('Shift')) m |= 8;
    return m;
  })();

  const common = {
    x: coords.xy.x,
    y: coords.xy.y,
    button: params.button,
    clickCount: params.clickCount,
    modifiers: modifierMask,
  };
  // Input.dispatchMouseEvent is page-level; do NOT route via sessionId.
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...common });
  await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...common });
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...common });

  return { success: true as const, elementText: coords.elementText };
}

async function activeTabId(): Promise<number | null> {
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return t?.id ?? null;
}
```

- [ ] **Step 3: Rewrite type.ts**

Replace the entire contents of `/Users/wxt/code/byob/packages/extension/lib/handlers/type.ts` with:

```ts
import { TypeInput } from '@byob/shared';
import { tryAttachToTab } from '../cdp.js';
import {
  resolveFrame,
  evaluateInResolvedFrame,
  frameErrorToEnvelope,
} from '../frame-resolver.js';

export async function handleType(rawParams: unknown): Promise<unknown> {
  const params = TypeInput.parse(rawParams);

  const tabId = params.tabId ?? (await activeTabId());
  if (tabId === null) return { error: 'unknown', message: 'No active tab' };

  const { session, reason } = await tryAttachToTab(tabId);
  if (!session) {
    if (reason === 'special_page') {
      return {
        error: 'url_forbidden',
        message: 'Active tab is on a special page (chrome://, devtools://, etc.) — CDP cannot attach.',
        hint: 'Switch to a regular http(s):// tab.',
      };
    }
    if (reason === 'tab_gone') return { error: 'tab_closed', message: 'Tab was closed.' };
    return {
      error: 'cdp_attach_failed',
      message: 'Could not attach Chrome debugger after 3 retries.',
      hint: 'Close DevTools (F12) on the target tab and retry.',
    };
  }

  let frame;
  try {
    frame = await resolveFrame(session, params.framePath);
  } catch (e) {
    const env = frameErrorToEnvelope(e);
    if (env) return env;
    throw e;
  }

  // Focus the element (and optionally clear) inside the resolved frame.
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
  const ok = await evaluateInResolvedFrame<boolean>(session, frame, focusExpr, {
    awaitPromise: false,
  });
  if (!ok) {
    return { error: 'selector_not_found', message: `No element matched ${params.selector}` };
  }

  // Input.insertText / dispatchKeyEvent are page-level. They route to the
  // currently focused element, which we just focused inside the iframe.
  await session.send('Input.insertText', { text: params.text });

  if (params.pressEnter) {
    const keyParams = {
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    };
    await session.send('Input.dispatchKeyEvent', { type: 'keyDown', ...keyParams });
    await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...keyParams });
  }

  return { success: true as const };
}

async function activeTabId(): Promise<number | null> {
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return t?.id ?? null;
}
```

- [ ] **Step 4: Type-check**

Run:

```bash
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
bun --cwd /Users/wxt/code/byob/packages/extension run typecheck
```

Expected: green.

- [ ] **Step 5: Commit**

```
feat(extension/handlers): click + type honor framePath

- click: uses resolveFrame + toPageCoords to send Input.dispatchMouseEvent
  with correct page-level coordinates that account for iframe nesting.
- type: focuses element inside the resolved frame via Runtime.evaluate
  with the frame's contextId, then issues page-level
  Input.insertText / dispatchKeyEvent (focus already lives inside
  the iframe, so the text lands there).
- Both map FrameError → ErrorEnvelope so callers see frame_not_found
  / frame_attach_failed with framePathIndex.
- framePath:[] (default) preserves v0.1 behavior bit-for-bit.
```

---

## Task 6: Update eval + wait-for handlers to use framePath

**Files:**
- Modify: `/Users/wxt/code/byob/packages/extension/lib/handlers/eval.ts`
- Modify: `/Users/wxt/code/byob/packages/extension/lib/handlers/wait-for.ts`

`browser_eval` and `browser_wait_for` need only context-id routing — no coordinate translation. Both run their expression in the resolved frame's `executionContextId`.

For `browser_eval`, sandboxed iframes (`sandbox=""` without `allow-scripts`) reject script injection — Chrome will throw on `Runtime.evaluate`. We catch this and return `frame_eval_blocked` instead of a generic `eval_exception`.

- [ ] **Step 1: Rewrite eval.ts**

Replace the entire contents of `/Users/wxt/code/byob/packages/extension/lib/handlers/eval.ts` with:

```ts
import { EvalInput } from '@byob/shared';
import { tryAttachToTab } from '../cdp.js';
import { notifyEval, recordAndCheckRate } from '../notify.js';
import { resolveFrame, frameErrorToEnvelope } from '../frame-resolver.js';

export async function handleEval(rawParams: unknown): Promise<unknown> {
  const params = EvalInput.parse(rawParams);

  const tabId = params.tabId ?? (await activeTabId());
  if (tabId === null) return { error: 'unknown', message: 'No active tab' };

  if (!recordAndCheckRate(tabId)) {
    return {
      error: 'rate_limited',
      message: 'Too many eval calls in this tab in the last minute',
    };
  }

  const tab = await chrome.tabs.get(tabId);
  notifyEval(tabId, tab.url ?? '', params.code);

  const { session, reason } = await tryAttachToTab(tabId);
  if (!session) {
    if (reason === 'special_page') {
      return {
        error: 'url_forbidden',
        message: 'Active tab is on a special page (chrome://, devtools://, etc.) — CDP cannot attach.',
        hint: 'Switch to a regular http(s):// tab.',
      };
    }
    if (reason === 'tab_gone') return { error: 'tab_closed', message: 'Tab was closed.' };
    return {
      error: 'cdp_attach_failed',
      message: 'Could not attach Chrome debugger after 3 retries.',
      hint: 'Close DevTools (F12) on the target tab and retry.',
    };
  }

  let frame;
  try {
    frame = await resolveFrame(session, params.framePath);
  } catch (e) {
    const env = frameErrorToEnvelope(e);
    if (env) return env;
    throw e;
  }

  // Route via sessionId for OOPIF, otherwise plain send().
  const evalParams = {
    contextId: frame.contextId,
    expression: params.code,
    awaitPromise: params.awaitPromise,
    returnByValue: params.returnByValue,
  };
  let res;
  try {
    res = frame.sessionId
      ? await session.sendOnSession<{
          result: { value?: unknown; type: string };
          exceptionDetails?: unknown;
        }>(frame.sessionId, 'Runtime.evaluate', evalParams)
      : await session.send<{
          result: { value?: unknown; type: string };
          exceptionDetails?: unknown;
        }>('Runtime.evaluate', evalParams);
  } catch (e) {
    // Sandbox iframe without allow-scripts surfaces here as a CDP error.
    const msg = e instanceof Error ? e.message : String(e);
    if (/sandbox|isolated|blocked/i.test(msg)) {
      return {
        error: 'frame_eval_blocked',
        message: `Eval blocked in target frame (sandboxed without allow-scripts?): ${msg}`,
        hint: 'Add allow-scripts to the iframe sandbox attribute, or evaluate in the main frame.',
      };
    }
    throw e;
  }
  if (res.exceptionDetails) {
    return {
      error: 'eval_exception',
      message: 'Page threw during eval',
      exceptionDetails: res.exceptionDetails,
    };
  }
  return { result: res.result?.value, resultType: res.result?.type ?? 'undefined' };
}

async function activeTabId(): Promise<number | null> {
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return t?.id ?? null;
}
```

- [ ] **Step 2: Rewrite wait-for.ts**

Replace the entire contents of `/Users/wxt/code/byob/packages/extension/lib/handlers/wait-for.ts` with:

```ts
import { WaitForInput } from '@byob/shared';
import { tryAttachToTab } from '../cdp.js';
import {
  resolveFrame,
  evaluateInResolvedFrame,
  frameErrorToEnvelope,
} from '../frame-resolver.js';

export async function handleWaitFor(rawParams: unknown): Promise<unknown> {
  const params = WaitForInput.parse(rawParams);

  const tabId = params.tabId ?? (await activeTabId());
  if (tabId === null) return { error: 'unknown', message: 'No active tab' };

  const { session, reason } = await tryAttachToTab(tabId);
  if (!session) {
    if (reason === 'special_page') {
      return {
        error: 'url_forbidden',
        message: 'Active tab is on a special page (chrome://, devtools://, etc.) — CDP cannot attach.',
        hint: 'Switch to a regular http(s):// tab.',
      };
    }
    if (reason === 'tab_gone') return { error: 'tab_closed', message: 'Tab was closed.' };
    return {
      error: 'cdp_attach_failed',
      message: 'Could not attach Chrome debugger after 3 retries.',
      hint: 'Close DevTools (F12) on the target tab and retry.',
    };
  }

  let frame;
  try {
    frame = await resolveFrame(session, params.framePath);
  } catch (e) {
    const env = frameErrorToEnvelope(e);
    if (env) return env;
    throw e;
  }

  const startedAt = Date.now();
  // MutationObserver runs *inside* the target frame; observer attached to
  // that frame's documentElement. The promise resolves on first match or
  // timeout.
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
      if (matches()) {
        obs.disconnect();
        clearTimeout(t);
        resolve({ ok: true, elapsedMs: Math.round(performance.now() - startedAt) });
      }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    const t = setTimeout(() => {
      obs.disconnect();
      resolve({ ok: false, elapsedMs: Math.round(performance.now() - startedAt) });
    }, ${params.timeoutSec * 1000});
  }))()`;

  const result = await evaluateInResolvedFrame<{ ok: boolean; elapsedMs: number }>(
    session,
    frame,
    expr,
    { awaitPromise: true, returnByValue: true },
  );

  if (!result.ok) {
    return {
      error: 'timeout',
      message: `wait_for ${params.selector} (${params.state}) timed out after ${params.timeoutSec}s`,
      elapsedMs: result.elapsedMs,
    };
  }
  return { found: true as const, elapsedMs: Date.now() - startedAt };
}

async function activeTabId(): Promise<number | null> {
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return t?.id ?? null;
}
```

- [ ] **Step 3: Type-check**

Run:

```bash
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
bun --cwd /Users/wxt/code/byob/packages/extension run typecheck
```

Expected: green.

- [ ] **Step 4: Commit**

```
feat(extension/handlers): eval + wait-for honor framePath

- eval: resolve frame → Runtime.evaluate({contextId}); CDP errors
  matching /sandbox|isolated|blocked/ map to frame_eval_blocked
  with a useful hint.
- wait-for: MutationObserver attaches to the resolved frame's
  documentElement (not the main frame's), so it sees mutations
  inside the iframe.
- Both: framePath:[] preserves v0.1 behavior.
```

---

## Task 7: Update read + download-images handlers to use framePath

**Files:**
- Modify: `/Users/wxt/code/byob/packages/extension/lib/handlers/read.ts`
- Modify: `/Users/wxt/code/byob/packages/extension/lib/handlers/download-images.ts`

These two handlers run a *long* expression (collector + scroll loops) in a tab. With framePath, the entire collector/scroller suite must execute inside the target frame's contextId — including the scroll loops, since `window.scrollBy` operates on whichever window the eval ran in.

There is one subtlety: when framePath is non-empty, the collector still operates on the inner frame's body. Some pages have an iframe that has its own scrollbar, others have iframes that scroll with the page. We accept "scroll the inner frame" as the correct semantics — when targeting an iframe explicitly, scroll its document; otherwise (empty framePath) scroll the main page exactly as v0.1 does.

For `read.ts`, `installBeforeunloadGuard(session)` is page-level — it should still run on the main session because navigating away from the top page kills any frame anyway. We don't move it.

- [ ] **Step 1: Update read.ts**

Open `/Users/wxt/code/byob/packages/extension/lib/handlers/read.ts`. Apply these targeted edits:

Replace the import block at the top (lines 1-6) with:

```ts
import { ReadInput, type Chunk } from '@byob/shared';
import { tryAttachToTab } from '../cdp.js';
import { openOrReuse } from '../tab.js';
import { checkUrlAllowed, urlForbiddenError } from '../url-guard.js';
import { keepAwakeStart, keepAwakeEnd } from '../keepalive.js';
import { installBeforeunloadGuard, uninstallBeforeunloadGuard } from '../beforeunload-guard.js';
import {
  resolveFrame,
  evaluateInResolvedFrame,
  frameErrorToEnvelope,
} from '../frame-resolver.js';
```

After the existing `tryAttachToTab` block (after line 119, just before `const startedAt = Date.now();`), insert frame resolution:

```ts
  // Resolve target frame. For framePath:[] this returns the main frame and
  // behavior matches v0.1.
  let frame;
  try {
    frame = await resolveFrame(session, params.framePath);
  } catch (e) {
    if (!tab.reused) await tab.cleanup();
    const env = frameErrorToEnvelope(e);
    if (env) return env;
    throw e;
  }
```

Replace every `session.evaluate(<expr>, <opts>)` call inside the body of `handleRead` with `evaluateInResolvedFrame(session, frame, <expr>, <opts>)`. Specifically:

| Line in current file | Change |
|---|---|
| `await session.evaluate(COLLECTOR_INSTALL, { awaitPromise: false });` | `await evaluateInResolvedFrame(session, frame, COLLECTOR_INSTALL, { awaitPromise: false });` |
| `await session.evaluate('window.__byobScrollOnce()', { awaitPromise: true });` (priming) | `await evaluateInResolvedFrame(session, frame, 'window.__byobScrollOnce()', { awaitPromise: true });` |
| `await session.evaluate('window.scrollTo(0, 0)', { awaitPromise: false });` | `await evaluateInResolvedFrame(session, frame, 'window.scrollTo(0, 0)', { awaitPromise: false });` |
| `await session.evaluate<CollectedChunk[]>('window.__byobCollect()', { awaitPromise: false });` | `await evaluateInResolvedFrame<CollectedChunk[]>(session, frame, 'window.__byobCollect()', { awaitPromise: false });` |
| `await session.evaluate<number>('document.documentElement.scrollHeight', ...)` | `await evaluateInResolvedFrame<number>(session, frame, 'document.documentElement.scrollHeight', ...)` |
| `await session.evaluate<boolean>('window.__byobAtBottom()', ...)` | `await evaluateInResolvedFrame<boolean>(session, frame, 'window.__byobAtBottom()', ...)` |
| `await session.evaluate('window.__byobScrollOnce()', { awaitPromise: true });` (loop) | `await evaluateInResolvedFrame(session, frame, 'window.__byobScrollOnce()', { awaitPromise: true });` |

`installBeforeunloadGuard(session)` and `uninstallBeforeunloadGuard(session)` stay unchanged — they target the page top-level, which is still correct (we want to block top-level navigation regardless of which frame we're reading).

- [ ] **Step 2: Update download-images.ts**

Open `/Users/wxt/code/byob/packages/extension/lib/handlers/download-images.ts`. Apply these targeted edits:

Replace the import block (lines 1-5) with:

```ts
import { DownloadImagesInput } from '@byob/shared';
import { tryAttachToTab } from '../cdp.js';
import { openOrReuse } from '../tab.js';
import { checkUrlAllowed, urlForbiddenError } from '../url-guard.js';
import { keepAwakeStart, keepAwakeEnd } from '../keepalive.js';
import {
  resolveFrame,
  evaluateInResolvedFrame,
  frameErrorToEnvelope,
} from '../frame-resolver.js';
```

After the existing `tryAttachToTab` block (after line ~131, just before `keepAwakeStart();`), insert:

```ts
  let frame;
  try {
    frame = await resolveFrame(session, params.framePath);
  } catch (e) {
    if (!tab.reused) await tab.cleanup();
    const env = frameErrorToEnvelope(e);
    if (env) return env;
    throw e;
  }
```

Replace every `session.evaluate(...)` call **inside the try-block of the keepAwake try/finally** with `evaluateInResolvedFrame(session, frame, ...)`. The `fetch(item.sourceUrl, ...)` calls and `fetch(uploadUrl, ...)` calls run in the *service worker* context (not via CDP), so they stay as-is. Only the `session.evaluate` calls change. Specifically:

- `await session.evaluate(COLLECTOR_INSTALL, ...)` → `evaluateInResolvedFrame(session, frame, COLLECTOR_INSTALL, ...)`
- `await session.evaluate('window.scrollTo(0, 0)', ...)` (both occurrences) → `evaluateInResolvedFrame(session, frame, 'window.scrollTo(0, 0)', ...)`
- `await session.evaluate('window.__byobScrollOnceForImages()', ...)` → `evaluateInResolvedFrame(session, frame, 'window.__byobScrollOnceForImages()', ...)`
- `await session.evaluate<CollectedCandidate[]>(\`window.__byobCollectImages(...)\`, ...)` → `evaluateInResolvedFrame<CollectedCandidate[]>(session, frame, ..., ...)`
- `await session.evaluate<{ w: number; h: number }>('({ w: window.innerWidth, h: window.innerHeight })', ...)` → `evaluateInResolvedFrame<{ w: number; h: number }>(session, frame, '({ w: window.innerWidth, h: window.innerHeight })', ...)`

The `bounds` field on returned images now refers to **frame-local viewport coords** (not page coords) when framePath is non-empty. Document this with an inline comment after the collector evaluate:

```ts
  // NB: bounds in `images[]` are viewport-relative to the resolved frame,
  // not the top page. For top-level use (framePath:[]) this matches v0.1.
```

- [ ] **Step 3: Type-check**

Run:

```bash
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
bun --cwd /Users/wxt/code/byob/packages/extension run typecheck
```

Expected: green.

- [ ] **Step 4: Commit**

```
feat(extension/handlers): read + download-images honor framePath

- read: collector install, priming scroll, all per-iteration eval
  calls, and the lazy-load scroller all run in the resolved frame's
  contextId. installBeforeunloadGuard stays page-level (top-level
  nav still kills the iframe).
- download-images: collector + scroll calls run in the resolved
  frame; image fetches still run in the service worker (page CSP
  workaround from v0.1 is unchanged). bounds[] semantics noted as
  frame-local when framePath != [].
- framePath:[] preserves v0.1 behavior bit-for-bit.
```

---

## Task 8: Update A-built handlers (read-markdown / extract-table / get-console-logs)

**Files:**
- Modify: `/Users/wxt/code/byob/packages/extension/lib/handlers/read-markdown.ts` (created by sub-project A)
- Modify: `/Users/wxt/code/byob/packages/extension/lib/handlers/extract-table.ts` (created by sub-project A)
- Modify: `/Users/wxt/code/byob/packages/extension/lib/handlers/get-console-logs.ts` (created by sub-project A)

A's three handlers ship without framePath awareness. D adds it the same way as the v0.1 handlers above. If sub-project A has not yet been implemented, **skip this task** — its tasks become a no-op when those files don't exist.

Two of the three (`read-markdown`, `extract-table`) follow the exact same pattern as `read.ts`: resolve frame, swap `session.evaluate` for `evaluateInResolvedFrame`. The third (`get-console-logs`) is different — `Runtime.consoleAPICalled` is per-session, not per-frame. We filter incoming events by `executionContextId` so only logs from the resolved frame are returned.

- [ ] **Step 1: Verify the A handler files exist**

Run:

```bash
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
ls -1 /Users/wxt/code/byob/packages/extension/lib/handlers/read-markdown.ts \
       /Users/wxt/code/byob/packages/extension/lib/handlers/extract-table.ts \
       /Users/wxt/code/byob/packages/extension/lib/handlers/get-console-logs.ts \
  2>&1
```

If any file is "No such file or directory", sub-project A has not been implemented yet. Skip to Task 9 and revisit Task 8 after A lands. Otherwise continue.

- [ ] **Step 2: Update read-markdown.ts**

Open the file. Add to the import block:

```ts
import {
  resolveFrame,
  evaluateInResolvedFrame,
  frameErrorToEnvelope,
} from '../frame-resolver.js';
```

Use `ReadMarkdownInput.parse(rawParams)` (which already merges `FramePathInput` from Task 1). After the existing `tryAttachToTab` success branch, insert:

```ts
  let frame;
  try {
    frame = await resolveFrame(session, params.framePath);
  } catch (e) {
    if (typeof tab !== 'undefined' && tab && !tab.reused) await tab.cleanup();
    const env = frameErrorToEnvelope(e);
    if (env) return env;
    throw e;
  }
```

(adjust `tab.cleanup()` reference to match A's variable name if different — read-markdown likely opens its own tab same as `read.ts`).

Replace every `session.evaluate(<expr>, <opts>)` in the body with `evaluateInResolvedFrame(session, frame, <expr>, <opts>)`. The `outerHTML` capture expression (whatever A wrote — typically `document.documentElement.outerHTML` or similar) is now captured for the resolved frame's document, which is what users want when targeting an iframe.

- [ ] **Step 3: Update extract-table.ts**

Same pattern as Step 2 — add the imports, resolve frame after attach, swap `session.evaluate` calls. The `document.querySelectorAll('table')` (or whatever A uses) now scans the resolved frame's document.

- [ ] **Step 4: Update get-console-logs.ts**

This handler is structurally different. A's version probably:

1. Enables `Runtime` (already done in `cdp.attach`) and `Log`
2. Subscribes to `Runtime.consoleAPICalled` and `Log.entryAdded`
3. Buffers them until the user calls again, or returns them after a duration

The framePath integration is *filtering*, not routing. After parsing params and resolving the frame, filter incoming events:

Find A's existing event-handling block. It likely looks something like:

```ts
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId !== tabId) return;
  if (method === 'Runtime.consoleAPICalled') {
    buffer.push(...);
  }
  ...
});
```

Add an `executionContextId` check so only events from the resolved frame's context get buffered. Concretely, after the existing `if (source.tabId !== tabId) return;` line, add:

```ts
  // framePath filter: drop events from other frames in the same tab.
  // The flatten-attach session sees executionContextId on consoleAPICalled
  // and Log.entryAdded; for OOPIFs the source.sessionId also matches.
  const evt = params as { executionContextId?: number };
  if (frame.contextId !== undefined && evt.executionContextId !== undefined) {
    if (evt.executionContextId !== frame.contextId) return;
  }
  if (frame.sessionId !== undefined && source.sessionId !== frame.sessionId) return;
```

For framePath:[] (main frame), `frame.contextId` is the main frame's context id, so the filter still narrows to the top page. If A's handler hands logs back without filtering by the active operation's frame at all, that's a behavior change worth a single-line note in the commit message.

- [ ] **Step 5: Type-check**

Run:

```bash
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
bun --cwd /Users/wxt/code/byob/packages/extension run typecheck
```

Expected: green. If A's handlers reference symbols (e.g. `evaluateInResolvedFrame`) that aren't imported, fix the imports.

- [ ] **Step 6: Commit**

```
feat(extension/handlers): A-introduced handlers honor framePath

- read-markdown: outerHTML capture runs in the resolved frame's
  contextId, so iframe-targeted markdown extraction works.
- extract-table: <table> enumeration now scans the resolved frame's
  document.
- get-console-logs: Runtime.consoleAPICalled / Log.entryAdded
  events are filtered by executionContextId (and sessionId for
  OOPIFs), so logs from other frames in the same tab don't leak in.
- framePath:[] preserves A's main-frame behavior.
```

---

## Task 9: Update e2e checklist with frame scenarios

**Files:**
- Modify: `/Users/wxt/code/byob/docs/e2e-checklist.md`

The unit tests for `frame-resolver` and `frame-coords` cover the math; the spec § 10 lists five real-Chrome scenarios that must pass before tagging v0.2. Encode them as a checklist with concrete URLs and expected outcomes.

Some scenarios reference public pages (W3Schools, demo Stripe iframe). For tests we cannot rely on third parties for, build a minimal local fixture file under `assets/fixtures/` and reference it by `file://`.

- [ ] **Step 1: Create local fixture for nested iframe**

Create `/Users/wxt/code/byob/assets/fixtures/iframe-nested.html`:

```html
<!doctype html>
<html><head><title>byob iframe-nested fixture</title></head>
<body>
  <h1>main</h1>
  <iframe class="outer" srcdoc='<html><body><h2>outer</h2><iframe class="inner" srcdoc="<html><body><h3>inner</h3><button id=go>go</button><div id=mark></div><script>document.getElementById(\"go\").addEventListener(\"click\",()=>{document.getElementById(\"mark\").textContent=\"clicked\";})</script></body></html>"></iframe></body></html>'></iframe>
</body></html>
```

(All on one line because nested `srcdoc` quoting is fragile; a multi-line file works too if HTML attribute escaping is preserved.)

For `file://` access tests, the user must run with `BYOB_ALLOW_FILE=1`.

- [ ] **Step 2: Append iframe e2e block to docs/e2e-checklist.md**

At the end of the file, add:

````markdown
## D — iframe / cross-frame addressing (v0.2)

Pre-req: `BYOB_ALLOW_FILE=1` for the local nested fixture; standard env for the others.

### Single-level iframe (same origin)

- [ ] In Chrome, open `https://www.w3schools.com/html/html_iframe.asp`.
- [ ] Run `browser_read framePath:['iframe[name="iframe_a"]']`.
      Expected: response `text` contains "W3Schools" placeholder text from the embedded frame, NOT the surrounding tutorial chrome.
- [ ] Run `browser_eval code:'document.title' framePath:['iframe[name="iframe_a"]']` (with `BYOB_ALLOW_EVAL=1`).
      Expected: `result` equals the inner-frame document title (different from the outer tutorial's title).

### Nested iframe (3 levels)

- [ ] Open `file:///Users/wxt/code/byob/assets/fixtures/iframe-nested.html` in Chrome (with `BYOB_ALLOW_FILE=1`).
- [ ] Run `browser_read framePath:['iframe.outer', 'iframe.inner']`.
      Expected: response `text` contains "inner".
- [ ] Run `browser_click framePath:['iframe.outer', 'iframe.inner'] selector:'#go'`.
- [ ] Run `browser_read framePath:['iframe.outer', 'iframe.inner']` again.
      Expected: response `text` now contains "clicked".

### Cross-origin OOPIF (Stripe demo)

- [ ] Open any page that embeds Stripe Elements (e.g. `https://stripe.com/docs/payments/quickstart` or a vendor checkout demo). Confirm DevTools shows the Stripe iframe is cross-origin.
- [ ] Run `browser_eval code:'location.host' framePath:['iframe[src*="stripe"]']`.
      Expected: `result` ends with "stripe.com" (proves OOPIF attach + contextId routing worked).

### click in iframe — coordinate translation

- [ ] On the local fixture, run `browser_click framePath:['iframe.outer', 'iframe.inner'] selector:'#go'`.
- [ ] Then `browser_eval code:'document.getElementById("mark").textContent' framePath:['iframe.outer', 'iframe.inner']`.
      Expected: `result === "clicked"`. Proves the page-level mouse event landed at the right coords inside the nested iframe.

### Error paths

- [ ] `browser_click framePath:['#nonexistent'] selector:'button'`.
      Expected: response envelope `error: 'frame_not_found'`, `framePathIndex: 0`, no `reason` (or `reason: undefined`).
- [ ] `browser_click framePath:['div.foo'] selector:'button'` against a page with a `<div class="foo">`.
      Expected: response `error: 'frame_not_found'`, `framePathIndex: 0`, `reason: 'not_an_iframe'`.
- [ ] `browser_eval framePath:['iframe[sandbox=""]'] code:'1+1'` against a page with `<iframe sandbox="">` (no allow-scripts).
      Expected: response `error: 'frame_eval_blocked'` with hint mentioning `allow-scripts`.

### Default behavior unchanged

- [ ] `browser_read https://news.ycombinator.com` (no `framePath`).
      Expected: same v0.1 output (HN frontpage stories).
- [ ] `browser_click selector:'#search'` on Google with no `framePath`.
      Expected: same v0.1 click behavior.
````

- [ ] **Step 3: Build the extension and run a quick manual smoke**

Run:

```bash
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
bun --cwd /Users/wxt/code/byob/packages/extension run build
```

Expected: WXT build succeeds, output in `packages/extension/.output/chrome-mv3/`. Reload the extension in Chrome (chrome://extensions → "Reload" on byob), then run the first scenario in the checklist (W3Schools single-frame read) manually. If it returns the correct iframe content, the implementation is working end-to-end. (Full e2e runs at release time; this is just a smoke test.)

- [ ] **Step 4: Commit**

```
docs(e2e): add iframe/OOPIF scenarios + local nested fixture

- New `assets/fixtures/iframe-nested.html` for offline 3-level
  iframe testing (uses srcdoc, no network deps).
- e2e-checklist.md gains a 'D — iframe / cross-frame addressing'
  section: single same-origin iframe, nested iframe, cross-origin
  OOPIF (Stripe), click coord translation, error paths
  (frame_not_found / not_an_iframe / frame_eval_blocked), and
  unchanged-default smoke.
```

---

## Task 10: Wire up MCP-server tool descriptions to mention framePath

**Files:**
- Modify: `/Users/wxt/code/byob/packages/mcp-server/src/tools/browser-read.ts`
- Modify: `/Users/wxt/code/byob/packages/mcp-server/src/tools/browser-click.ts`
- Modify: `/Users/wxt/code/byob/packages/mcp-server/src/tools/browser-type.ts`
- Modify: `/Users/wxt/code/byob/packages/mcp-server/src/tools/browser-eval.ts`
- Modify: `/Users/wxt/code/byob/packages/mcp-server/src/tools/browser-wait-for.ts`
- Modify: `/Users/wxt/code/byob/packages/mcp-server/src/tools/browser-download-images.ts`
- Modify (if A built): `/Users/wxt/code/byob/packages/mcp-server/src/tools/browser-read-markdown.ts`
- Modify (if A built): `/Users/wxt/code/byob/packages/mcp-server/src/tools/browser-extract-table.ts`
- Modify (if A built): `/Users/wxt/code/byob/packages/mcp-server/src/tools/browser-get-console-logs.ts`

The MCP `inputSchema: <ZodObject>.shape` already picks up the new optional `framePath` field automatically — no schema-side change needed there. But the LLM only knows what's in the tool **description**. Adding one sentence about framePath drastically improves agent behavior (it'll actually use it).

This is a documentation-only task; no behavior change.

- [ ] **Step 1: Append framePath docs to each tool's description**

For each of the 6 v0.1 tool registration files, locate the `description:` string and append (separated by space):

```
'Optionally pass framePath:[<iframe-css-selector>, ...] to operate inside a nested iframe (each entry selects an <iframe> in the prior level). Empty/omitted = main page.'
```

Concrete edit for `/Users/wxt/code/byob/packages/mcp-server/src/tools/browser-click.ts`:

Replace the `description:` lines (lines 11-14) with:

```ts
      description:
        'Click an element matching the given CSS selector in the active browser tab. ' +
        'Dispatches real mouse events via Chrome DevTools Protocol (not synthetic DOM events), ' +
        'so anti-bot heuristics see this as user input. ' +
        'Optionally pass framePath:[<iframe-css-selector>, ...] to operate inside a nested iframe ' +
        '(each entry selects an <iframe> in the prior level). Empty/omitted = main page.',
```

Apply the same one-line append to:
- `browser-read.ts`
- `browser-type.ts`
- `browser-eval.ts`
- `browser-wait-for.ts`
- `browser-download-images.ts`

If `browser-read-markdown.ts`, `browser-extract-table.ts`, `browser-get-console-logs.ts` exist (sub-project A built them), apply the same append to those as well.

- [ ] **Step 2: Type-check the mcp-server package**

Run:

```bash
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
bun --cwd /Users/wxt/code/byob/packages/mcp-server run typecheck
```

Expected: green.

- [ ] **Step 3: Run the full workspace typecheck once more**

Run:

```bash
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
bun --cwd /Users/wxt/code/byob run typecheck
```

Expected: all four packages green.

- [ ] **Step 4: Run all unit tests one final time**

Run:

```bash
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
bun test /Users/wxt/code/byob/packages/extension/lib/__tests__/
```

Expected: 13 tests pass (6 frame-resolver + 7 frame-coords).

- [ ] **Step 5: Commit**

```
docs(mcp-server): mention framePath in 9 tool descriptions

- LLMs only see what's in description; appending a one-sentence
  framePath hint to read / click / type / eval / wait-for /
  download-images (plus A's read-markdown / extract-table /
  get-console-logs when built) makes agents actually reach for
  framePath instead of failing silently against iframe-locked UIs.
- inputSchema picks the new optional field up automatically via
  Zod .shape; no schema-side change needed here.
```

---

## Verification (final)

After Task 10:

- [ ] `bun --cwd /Users/wxt/code/byob run typecheck` — all four packages green.
- [ ] `bun test /Users/wxt/code/byob/packages/extension/lib/__tests__/` — 13 unit tests pass.
- [ ] `bun --cwd /Users/wxt/code/byob/packages/extension run build` — WXT bundle builds without warnings.
- [ ] Manual smoke from e2e checklist Task 9: at minimum the W3Schools single-frame read returns iframe content.

If anything fails, fix in place — do not paper over with a second commit.

