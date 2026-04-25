# A 三件套 (Read Tools Trio) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three new MCP read-tools to byob — `browser_get_console_logs`, `browser_read_markdown`, `browser_extract_table` — built on the existing CDP / Native Messaging / loopback-HTTP infrastructure, with no new cross-cutting concerns.

**Architecture:** Each tool slots into the existing 4-package monorepo: shared adds 3 Zod schemas + command names; mcp-server adds 3 stdio tool registrations that POST to bridge HTTP routes; bridge adds 3 routes (`/get-console-logs`, `/read-markdown`, `/extract-table`) where `/read-markdown` mounts a new internal `readability-server` HTTP endpoint on the existing upload-server, and the extension adds 3 handlers — `get-console-logs.ts` uses CDP `Runtime.enable` + `Log.enable` snapshot, `read-markdown.ts` snapshots `outerHTML` via `chrome.scripting.executeScript` and POSTs it to the bridge `/readability` loopback endpoint for jsdom + readability + turndown processing, and `extract-table.ts` runs a pure DOM walker via `chrome.scripting.executeScript`.

**Tech Stack:** TypeScript strict · bun workspaces · Node 20+ (bridge) · WXT MV3 (extension) · CDP `Runtime.consoleAPICalled` / `Log.entryAdded` · `chrome.scripting.executeScript` (ISOLATED world) · `@mozilla/readability` · `turndown` · `jsdom` · `bun:test` (shared / bridge unit tests)

**Spec reference:** `/Users/wxt/code/byob/docs/superpowers/specs/2026-04-25-read-tools-trio-design.md`

**Future-proofing notes (read before starting):**
- Sub-project D (iframe support) will later add a `framePath` input field to all 3 handlers. Define handler signatures so adding one more optional field is non-breaking. Do NOT implement frame routing here.
- Sub-project B (Cancel/Abort) will later thread `AbortSignal` through bridge → extension. Don't add abort plumbing here, but keep loops short (≤ 5s flushDelayMs cap, plain awaits) so future cancel can interrupt cleanly without contorted refactors.

---

## File Structure

```
shared/src/
  commands.ts                        ← MODIFY: add 3 command name constants
  schemas.ts                         ← MODIFY: add 3 input/output schemas + UrlOrTabId helper
  schemas.test.ts                    ← CREATE: bun:test sanity for new schemas

packages/extension/lib/handlers/
  get-console-logs.ts                ← CREATE: CDP snapshot console + exceptions
  read-markdown.ts                   ← CREATE: scripting.executeScript outerHTML → bridge /readability
  extract-table.ts                   ← CREATE: scripting.executeScript table walker
  index.ts                           ← MODIFY: register 3 new handlers

packages/bridge/src/
  upload-server.ts                   ← MODIFY: also serve POST /readability on the same one-shot server
  readability-server.ts              ← CREATE: pure jsdom + readability + turndown converter
  readability-server.test.ts         ← CREATE: bun:test pure conversion fn (no HTTP)
  main.ts                            ← MODIFY: 3 new routes; read-markdown route boots upload-server with /readability handler

packages/mcp-server/src/tools/
  browser-get-console-logs.ts        ← CREATE: tool registration
  browser-read-markdown.ts           ← CREATE: tool registration
  browser-extract-table.ts           ← CREATE: tool registration
  index.ts                           ← MODIFY: register 3 new tools

packages/bridge/package.json         ← MODIFY: add @mozilla/readability + turndown + jsdom + types

docs/e2e-checklist.md                ← MODIFY: append 5 new e2e items
```

---

## Task 1: shared — add 3 schemas + UrlOrTabId helper

**Files:**
- Modify: `/Users/wxt/code/byob/shared/src/commands.ts`
- Modify: `/Users/wxt/code/byob/shared/src/schemas.ts`
- Create: `/Users/wxt/code/byob/shared/src/schemas.test.ts`

- [ ] **Step 1.1: Add 3 command name constants**

Edit `/Users/wxt/code/byob/shared/src/commands.ts`. Replace the whole file with:

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
  GetConsoleLogs: 'getConsoleLogs',
  ReadMarkdown:   'readMarkdown',
  ExtractTable:   'extractTable',
} as const;

export type CommandName = (typeof Command)[keyof typeof Command];
```

- [ ] **Step 1.2: Append 3 schemas + UrlOrTabId helper to schemas.ts**

Edit `/Users/wxt/code/byob/shared/src/schemas.ts`. Append at the bottom of the file (after the `DownloadImagesOutput` block):

```ts
// ---------- Common: url-or-tabId base ----------
// Three new "read-style" tools (12-14 below) take url XOR tabId. Express the
// xor as a refinement so handlers can rely on at-least-one being present.
// Future: sub-project D will add an optional `framePath` field next to these.
export const UrlOrTabIdRaw = z.object({
  url: z.string().url().optional(),
  tabId: z.number().int().optional(),
});
function requireUrlOrTabId<T extends z.AnyZodObject>(schema: T) {
  return schema.refine((v) => v.url !== undefined || v.tabId !== undefined, {
    message: 'either url or tabId is required',
  });
}

// ---------- 12. browser_get_console_logs ----------
export const GetConsoleLogsInputRaw = UrlOrTabIdRaw.extend({
  level: z
    .array(z.enum(['log', 'info', 'warn', 'error', 'debug']))
    .default(['warn', 'error']),
  includeExceptions: z.boolean().default(true),
  flushDelayMs: z.number().int().min(0).max(5000).default(200),
});
export const GetConsoleLogsInput = requireUrlOrTabId(GetConsoleLogsInputRaw);
export const ConsoleLogEntrySchema = z.object({
  // 'exception' is output-only — input.level cannot select it; the
  // includeExceptions toggle controls whether they appear in output.
  level: z.enum(['log', 'info', 'warn', 'error', 'debug', 'exception']),
  text: z.string(),
  source: z.string().optional(),
  lineno: z.number().optional(),
  colno: z.number().optional(),
  timestamp: z.number(),
  stackTrace: z.string().optional(),
});
export const GetConsoleLogsOutput = z.object({
  logs: z.array(ConsoleLogEntrySchema),
  truncated: z.boolean(),
  tabId: z.number().int(),
  url: z.string(),
});

// ---------- 13. browser_read_markdown ----------
export const ReadMarkdownInputRaw = UrlOrTabIdRaw.extend({
  includeMetadata: z.boolean().default(true),
  includeImages: z.boolean().default(true),
  preserveCode: z.boolean().default(true),
  maxLength: z.number().int().min(1).optional(),
});
export const ReadMarkdownInput = requireUrlOrTabId(ReadMarkdownInputRaw);
export const ReadMarkdownOutput = z.object({
  markdown: z.string(),
  title: z.string().optional(),
  byline: z.string().optional(),
  excerpt: z.string().optional(),
  lengthChars: z.number().int(),
  truncated: z.boolean().optional(),
  tabId: z.number().int(),
  url: z.string(),
});

// ---------- 14. browser_extract_table ----------
export const ExtractTableInputRaw = UrlOrTabIdRaw.extend({
  selector: z.string().default('table'),
  format: z.enum(['rows', 'objects']).default('rows'),
});
export const ExtractTableInput = requireUrlOrTabId(ExtractTableInputRaw);
export const ExtractedTableSchema = z.object({
  selector: z.string(),
  headers: z.array(z.string()),
  // rows is one of: string[][] OR Record<string,string>[]; we keep the
  // schema permissive (z.unknown()) and trust the handler — Zod can't
  // express discriminated arrays well without a generic.
  rows: z.array(z.unknown()),
  rowCount: z.number().int(),
});
export const ExtractTableOutput = z.object({
  tables: z.array(ExtractedTableSchema),
  tabId: z.number().int(),
  url: z.string(),
});
```

- [ ] **Step 1.3: Write a sanity unit test**

Create `/Users/wxt/code/byob/shared/src/schemas.test.ts`:

```ts
import { test, expect } from 'bun:test';
import {
  GetConsoleLogsInput,
  GetConsoleLogsInputRaw,
  ReadMarkdownInput,
  ExtractTableInput,
} from './schemas.js';

test('GetConsoleLogsInput requires url or tabId', () => {
  expect(() => GetConsoleLogsInput.parse({})).toThrow();
  expect(GetConsoleLogsInput.parse({ url: 'https://example.com' }).level).toEqual(['warn', 'error']);
  expect(GetConsoleLogsInput.parse({ tabId: 1 }).flushDelayMs).toBe(200);
});

test('GetConsoleLogsInput.level rejects exception (input-only filter)', () => {
  // Spec § 4.1: input level array must NOT include 'exception'.
  expect(() =>
    GetConsoleLogsInputRaw.parse({ url: 'https://example.com', level: ['exception'] }),
  ).toThrow();
});

test('GetConsoleLogsInput.flushDelayMs is capped at 5000', () => {
  expect(() => GetConsoleLogsInput.parse({ url: 'https://example.com', flushDelayMs: 5001 })).toThrow();
});

test('ReadMarkdownInput defaults', () => {
  const v = ReadMarkdownInput.parse({ url: 'https://example.com' });
  expect(v.includeImages).toBe(true);
  expect(v.preserveCode).toBe(true);
  expect(v.maxLength).toBeUndefined();
});

test('ExtractTableInput defaults selector to table and format to rows', () => {
  const v = ExtractTableInput.parse({ tabId: 7 });
  expect(v.selector).toBe('table');
  expect(v.format).toBe('rows');
});

test('ExtractTableInput rejects empty body', () => {
  expect(() => ExtractTableInput.parse({})).toThrow();
});
```

- [ ] **Step 1.4: Run tests + typecheck**

Run:

```sh
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
cd /Users/wxt/code/byob && bun test shared/src/schemas.test.ts
cd /Users/wxt/code/byob && bun --cwd shared run typecheck
```

Expected: 6 tests pass; typecheck exits 0.

- [ ] **Step 1.5: Commit**

Tell user to run (do NOT run yourself):

```bash
git add shared/src/commands.ts shared/src/schemas.ts shared/src/schemas.test.ts
git commit -m "$(cat <<'EOF'
feat(shared): schemas + commands for console-logs / read-markdown / extract-table

Adds the @byob/shared half of the v0.2 read-tools trio: 3 input + 3 output
Zod schemas, a UrlOrTabId xor helper, and 3 NM command-name constants.
ConsoleLogEntry.level adds 'exception' on output only — input filter array
remains the 5 console API levels (a separate includeExceptions toggle gates
exceptions). bun:test for refinement + defaults.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: bridge — add readability-server module + dependencies

**Files:**
- Modify: `/Users/wxt/code/byob/packages/bridge/package.json`
- Create: `/Users/wxt/code/byob/packages/bridge/src/readability-server.ts`
- Create: `/Users/wxt/code/byob/packages/bridge/src/readability-server.test.ts`

- [ ] **Step 2.1: Add dependencies to bridge package.json**

Edit `/Users/wxt/code/byob/packages/bridge/package.json`. Replace the `dependencies` block with:

```json
  "dependencies": {
    "@byob/shared": "workspace:*",
    "@mozilla/readability": "^0.5.0",
    "commander": "^12.0.0",
    "jsdom": "^25.0.1",
    "turndown": "^7.2.0",
    "undici": "^7.0.0"
  },
```

And replace the `devDependencies` block with:

```json
  "devDependencies": {
    "@types/bun": "1.3.13",
    "@types/jsdom": "^21.1.7",
    "@types/node": "^22.0.0",
    "@types/turndown": "^5.0.5",
    "tsx": "^4.0.0",
    "typescript": "^5.6.0"
  }
```

- [ ] **Step 2.2: Install**

Run:

```sh
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
cd /Users/wxt/code/byob && bun install
```

Expected: 4 new packages resolved (`@mozilla/readability`, `jsdom`, `turndown`, types). No errors. (If install fails on a network blip, just rerun — bun is idempotent.)

- [ ] **Step 2.3: Create the pure conversion module**

Create `/Users/wxt/code/byob/packages/bridge/src/readability-server.ts`:

```ts
// Pure HTML → markdown converter used by the /readability loopback HTTP
// endpoint. Kept as a separate module so unit tests can call htmlToMarkdown()
// directly without spinning up an HTTP server.
//
// Pipeline:
//   raw HTML  →  jsdom (build DOM)
//             →  Readability (extract article)  → metadata + cleaned HTML
//             →  turndown (HTML → markdown)
//             →  optional truncate
//
// Why bridge-side: extension (MV3) cannot bundle jsdom (Node-only). Bridge is
// already a Node process and already has a loopback HTTP server (upload-server)
// for similar oversize-payload cases (download-images). We piggy-back the
// /readability route on that same server (Task 3).

import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';

export interface ConvertOptions {
  includeMetadata: boolean;
  includeImages: boolean;
  preserveCode: boolean;
  maxLength?: number;
}

export interface ConvertResult {
  markdown: string;
  title?: string;
  byline?: string;
  excerpt?: string;
  lengthChars: number;
  truncated?: boolean;
}

export class ReadabilityNoArticleError extends Error {
  // Carry HTML length so callers / clients can decide whether to retry
  // with browser_read fallback.
  constructor(public readonly htmlLength: number) {
    super('Readability did not identify a main article');
    this.name = 'ReadabilityNoArticleError';
  }
}

function buildTurndown(opts: ConvertOptions): TurndownService {
  const td = new TurndownService({
    codeBlockStyle: opts.preserveCode ? 'fenced' : 'indented',
    headingStyle: 'atx',
    bulletListMarker: '-',
  });
  if (!opts.includeImages) {
    // Drop <img> entirely (no markdown emitted) and unwrap their parent <a>
    // when the only child was the image.
    td.addRule('drop-images', {
      filter: ['img'],
      replacement: () => '',
    });
  }
  return td;
}

export function htmlToMarkdown(rawHtml: string, opts: ConvertOptions, sourceUrl?: string): ConvertResult {
  // jsdom needs a base URL so relative URLs (img src, anchor href) resolve.
  // If the caller didn't pass one, fall back to about:blank — the Readability
  // article body just won't have working relative links, which is acceptable.
  const dom = new JSDOM(rawHtml, { url: sourceUrl ?? 'about:blank' });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();
  if (!article || !article.content) {
    throw new ReadabilityNoArticleError(rawHtml.length);
  }

  const td = buildTurndown(opts);
  let markdown = td.turndown(article.content).trim();

  let truncated: boolean | undefined;
  if (opts.maxLength && markdown.length > opts.maxLength) {
    markdown = markdown.slice(0, opts.maxLength) + '\n\n[truncated]\n';
    truncated = true;
  }

  const result: ConvertResult = {
    markdown,
    lengthChars: markdown.length,
  };
  if (opts.includeMetadata) {
    if (article.title) result.title = article.title;
    if (article.byline) result.byline = article.byline;
    if (article.excerpt) result.excerpt = article.excerpt;
  }
  if (truncated) result.truncated = true;
  return result;
}
```

- [ ] **Step 2.4: Write unit tests for the converter**

Create `/Users/wxt/code/byob/packages/bridge/src/readability-server.test.ts`:

```ts
import { test, expect } from 'bun:test';
import {
  htmlToMarkdown,
  ReadabilityNoArticleError,
} from './readability-server.js';

const ARTICLE_HTML = `
<!doctype html>
<html><head><title>Hello world</title></head>
<body>
  <nav><a href="/">home</a> <a href="/about">about</a></nav>
  <article>
    <h1>Hello world</h1>
    <p class="byline">By Jane Doe</p>
    <p>This is a paragraph with <strong>bold</strong> text and <a href="https://example.com">a link</a>.</p>
    <p>Another paragraph long enough to keep Readability happy. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Phasellus euismod, libero a luctus.</p>
    <pre><code>const x = 1;</code></pre>
    <p><img src="https://example.com/image.png" alt="example image"></p>
  </article>
  <footer>copyright</footer>
</body></html>`;

test('htmlToMarkdown extracts title + body, default opts', () => {
  const r = htmlToMarkdown(ARTICLE_HTML, {
    includeMetadata: true,
    includeImages: true,
    preserveCode: true,
  });
  expect(r.title).toBe('Hello world');
  expect(r.markdown).toContain('Hello world');
  expect(r.markdown).toContain('**bold**');
  expect(r.markdown).toContain('```');
  expect(r.markdown).toContain('![example image]');
  expect(r.lengthChars).toBe(r.markdown.length);
});

test('htmlToMarkdown drops images when includeImages=false', () => {
  const r = htmlToMarkdown(ARTICLE_HTML, {
    includeMetadata: true,
    includeImages: false,
    preserveCode: true,
  });
  expect(r.markdown).not.toContain('![');
  expect(r.markdown).not.toContain('example.com/image.png');
});

test('htmlToMarkdown emits indented code blocks when preserveCode=false', () => {
  const r = htmlToMarkdown(ARTICLE_HTML, {
    includeMetadata: false,
    includeImages: true,
    preserveCode: false,
  });
  expect(r.markdown).not.toContain('```');
  // Indented code blocks render as 4-space-prefixed lines.
  expect(r.markdown).toMatch(/    const x = 1;/);
  expect(r.title).toBeUndefined();
});

test('htmlToMarkdown truncates and marks truncated', () => {
  const r = htmlToMarkdown(ARTICLE_HTML, {
    includeMetadata: false,
    includeImages: true,
    preserveCode: true,
    maxLength: 50,
  });
  expect(r.truncated).toBe(true);
  expect(r.markdown.endsWith('\n\n[truncated]\n')).toBe(true);
  // markdown is the truncated text + suffix; lengthChars matches that.
  expect(r.lengthChars).toBe(r.markdown.length);
});

test('htmlToMarkdown throws ReadabilityNoArticleError on empty body', () => {
  // A page with no recognizable article content. Readability returns null.
  const html = '<!doctype html><html><body></body></html>';
  try {
    htmlToMarkdown(html, {
      includeMetadata: true,
      includeImages: true,
      preserveCode: true,
    });
    throw new Error('expected throw');
  } catch (e) {
    expect(e).toBeInstanceOf(ReadabilityNoArticleError);
    expect((e as ReadabilityNoArticleError).htmlLength).toBe(html.length);
  }
});
```

- [ ] **Step 2.5: Run the tests**

Run:

```sh
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
cd /Users/wxt/code/byob && bun test packages/bridge/src/readability-server.test.ts
cd /Users/wxt/code/byob && bun --cwd packages/bridge run typecheck
```

Expected: 5 tests pass; typecheck exits 0.

- [ ] **Step 2.6: Commit**

Tell user to run:

```bash
git add packages/bridge/package.json packages/bridge/src/readability-server.ts packages/bridge/src/readability-server.test.ts bun.lock
git commit -m "$(cat <<'EOF'
feat(bridge): readability-server pure converter + jsdom/readability/turndown deps

Pure HTML → markdown module used by the upcoming /readability loopback HTTP
route. Pipeline is jsdom + Mozilla Readability + turndown. Options cover
metadata, images, fenced/indented code, and maxLength truncation. Throws a
typed ReadabilityNoArticleError carrying htmlLength so future error envelopes
can give the client a useful debug hint.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: bridge upload-server — also serve POST /readability

**Files:**
- Modify: `/Users/wxt/code/byob/packages/bridge/src/upload-server.ts`

`/readability` reuses the **same** loopback HTTP server already booted by download-images. The bridge-side route handler in main.ts (Task 4) will call `startUploadServer()` regardless of whether saveDir matters; the new endpoint just lives next to `/upload`. This keeps the firewall surface small (still one ephemeral 127.0.0.1 port per call).

- [ ] **Step 3.1: Wire /readability into upload-server.ts**

Edit `/Users/wxt/code/byob/packages/bridge/src/upload-server.ts`. Replace the existing `import` block at the top of the file with:

```ts
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { htmlToMarkdown, ReadabilityNoArticleError, type ConvertOptions, type ConvertResult } from './readability-server.js';
```

Then locate the inner `void (async () => { ... })()` IIFE inside `http.createServer((req, res) => { ... })`. Inside the `try { ... }` block, immediately AFTER the `if (req.method === 'OPTIONS') { ... }` block and BEFORE the `if (req.method !== 'POST') { ... }` block, insert this new branch:

```ts
        // ---- /readability route (read_markdown handler) ----
        // Body shape: { html, sourceUrl?, options: ConvertOptions }
        // Response (200): ConvertResult JSON
        // Response (400): { ok:false, code:'readability_no_article' | 'html_parse_failed', ... }
        if (req.method === 'POST') {
          const u0 = new URL(req.url ?? '', 'http://localhost');
          if (u0.pathname === '/readability') {
            if (u0.searchParams.get('secret') !== secret) {
              res.writeHead(403, corsHeaders);
              return res.end();
            }
            const chunks: Buffer[] = [];
            req.on('data', (c: Uint8Array) => chunks.push(Buffer.from(c)));
            req.on('end', () => {
              try {
                const raw = Buffer.concat(chunks).toString('utf-8');
                const parsed = JSON.parse(raw) as {
                  html?: unknown;
                  sourceUrl?: unknown;
                  options?: unknown;
                };
                const html = typeof parsed.html === 'string' ? parsed.html : '';
                const sourceUrl = typeof parsed.sourceUrl === 'string' ? parsed.sourceUrl : undefined;
                const optsIn = (parsed.options ?? {}) as Partial<ConvertOptions>;
                const opts: ConvertOptions = {
                  includeMetadata: optsIn.includeMetadata !== false,
                  includeImages: optsIn.includeImages !== false,
                  preserveCode: optsIn.preserveCode !== false,
                  maxLength: typeof optsIn.maxLength === 'number' ? optsIn.maxLength : undefined,
                };
                let result: ConvertResult;
                try {
                  result = htmlToMarkdown(html, opts, sourceUrl);
                } catch (e) {
                  if (e instanceof ReadabilityNoArticleError) {
                    res.writeHead(400, { ...corsHeaders, 'Content-Type': 'application/json' });
                    return res.end(
                      JSON.stringify({
                        ok: false,
                        code: 'readability_no_article',
                        htmlLength: e.htmlLength,
                      }),
                    );
                  }
                  res.writeHead(400, { ...corsHeaders, 'Content-Type': 'application/json' });
                  return res.end(
                    JSON.stringify({
                      ok: false,
                      code: 'html_parse_failed',
                      message: e instanceof Error ? e.message : String(e),
                    }),
                  );
                }
                res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, ...result }));
              } catch (e) {
                res.writeHead(500, { ...corsHeaders, 'Content-Type': 'application/json' });
                res.end(
                  JSON.stringify({
                    ok: false,
                    code: 'html_parse_failed',
                    message: e instanceof Error ? e.message : String(e),
                  }),
                );
              }
            });
            req.on('error', (err) => {
              res.writeHead(500, { ...corsHeaders, 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, code: 'html_parse_failed', message: err.message }));
            });
            return;
          }
        }
```

Then update the returned object — locate the `return { port, secret, endpoint: ... };` block at the bottom of `startUploadServer` and replace it with:

```ts
  return {
    port,
    secret,
    endpoint: `http://127.0.0.1:${port}/upload`,
    readabilityEndpoint: `http://127.0.0.1:${port}/readability`,
    close: () =>
      new Promise<void>((resolve) => {
        try {
          server.closeAllConnections?.();
        } catch {
          // ignore
        }
        server.close(() => resolve());
      }),
  };
```

Then update the `UploadServer` interface near the top of the file. Replace its definition with:

```ts
export interface UploadServer {
  port: number;
  secret: string;
  endpoint: string;
  /** Same server, /readability route — used by browser_read_markdown. */
  readabilityEndpoint: string;
  close(): Promise<void>;
}
```

- [ ] **Step 3.2: Typecheck**

Run:

```sh
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
cd /Users/wxt/code/byob && bun --cwd packages/bridge run typecheck
```

Expected: typecheck exits 0.

- [ ] **Step 3.3: Commit**

Tell user to run:

```bash
git add packages/bridge/src/upload-server.ts
git commit -m "$(cat <<'EOF'
feat(bridge): /readability HTTP route on the loopback upload-server

Mounts a POST /readability endpoint on the same one-shot 127.0.0.1 server
that download-images already uses. Body { html, sourceUrl?, options } →
ConvertResult JSON, secret-gated identically to /upload. Errors surface as
{ ok:false, code:'readability_no_article'|'html_parse_failed' } so the
extension-side handler can map them to typed envelopes.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: bridge main.ts — wire 3 new IPC routes

**Files:**
- Modify: `/Users/wxt/code/byob/packages/bridge/src/main.ts`

`/get-console-logs` and `/extract-table` are simple `routeFor(...)` passthroughs. `/read-markdown` has to spin up the upload-server (for `/readability`) and pass `readabilityEndpoint + secret` into the params before forwarding — same pattern as `downloadImagesRoute`.

- [ ] **Step 4.1: Replace the tools map**

Edit `/Users/wxt/code/byob/packages/bridge/src/main.ts`. Locate the `const tools: IpcHandlers['tools'] = { ... };` block and replace it with:

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
  'get-console-logs': routeFor('getConsoleLogs', 30),
  'read-markdown':    readMarkdownRoute,
  'extract-table':    routeFor('extractTable', 30),
};
```

- [ ] **Step 4.2: Add the readMarkdownRoute function**

Still in `/Users/wxt/code/byob/packages/bridge/src/main.ts`, add this function right BELOW the `downloadImagesRoute` function:

```ts
async function readMarkdownRoute(body: unknown): Promise<{ status: number; body: unknown }> {
  const params = (body ?? {}) as Record<string, unknown>;
  // /readability uses a temp dir only because startUploadServer mkdir's it
  // up-front for download-images. We point it at a unique throwaway path so
  // we never accidentally touch real downloads.
  const scratchDir = path.join(DOWNLOADS_DIR, '.readability-' + Date.now());
  let upload: Awaited<ReturnType<typeof startUploadServer>> | null = null;
  try {
    upload = await startUploadServer(scratchDir);
    const timeoutSec = typeof params.timeoutSec === 'number' ? params.timeoutSec : 60;
    const enriched = {
      ...params,
      // Extension reads these two and POSTs HTML to readabilityEndpoint.
      readabilityEndpoint: upload.readabilityEndpoint,
      readabilitySecret: upload.secret,
    };
    const result = (await sendCommand('readMarkdown', enriched, timeoutSec * 1000 + 60_000)) as Record<
      string,
      unknown
    >;
    if (typeof result.error === 'string') return { status: 502, body: result };
    return { status: 200, body: result };
  } catch (e) {
    return {
      status: 500,
      body: { error: 'unknown', message: e instanceof Error ? e.message : String(e) },
    };
  } finally {
    if (upload) await upload.close();
    // Clean up the empty scratch dir if no /upload calls landed in it.
    try {
      const entries = fs.readdirSync(scratchDir);
      if (entries.length === 0) fs.rmdirSync(scratchDir);
    } catch {
      // ignore: dir may already be gone or non-empty
    }
  }
}
```

- [ ] **Step 4.3: Typecheck**

Run:

```sh
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
cd /Users/wxt/code/byob && bun --cwd packages/bridge run typecheck
```

Expected: typecheck exits 0.

- [ ] **Step 4.4: Commit**

Tell user to run:

```bash
git add packages/bridge/src/main.ts
git commit -m "$(cat <<'EOF'
feat(bridge): IPC routes for get-console-logs / read-markdown / extract-table

Three new POST routes plumb the new MCP tools to the extension over Native
Messaging. read-markdown additionally boots a per-call upload-server (same
mechanism as download-images) so the extension can stream the page outerHTML
to /readability for jsdom + Readability + turndown conversion.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: extension handler — get-console-logs.ts

**Files:**
- Create: `/Users/wxt/code/byob/packages/extension/lib/handlers/get-console-logs.ts`

Snapshot strategy:
1. Resolve tab via existing `openOrReuse` (when url given) or by tabId lookup.
2. CDP attach via existing `tryAttachToTab`.
3. Add the listener, call `Runtime.enable` + `Log.enable` (history is replayed via the events that arrive after enable).
4. Wait `flushDelayMs` (default 200ms, hard cap 5s — already enforced by Zod).
5. Filter, map, return. Detach if we opened the tab; leave attached if we reused (matches existing handlers).

- [ ] **Step 5.1: Write the handler**

Create `/Users/wxt/code/byob/packages/extension/lib/handlers/get-console-logs.ts`:

```ts
import { GetConsoleLogsInput } from '@byob/shared';
import { tryAttachToTab } from '../cdp.js';
import { openOrReuse } from '../tab.js';
import { checkUrlAllowed, urlForbiddenError } from '../url-guard.js';

// Heuristic threshold: if Runtime.enable replays >= 1000 events we mark the
// snapshot as truncated. CDP's default in-memory console buffer is 1000 (see
// inspector_protocol RuntimeAgent::s_consoleAPICalledCountMax). It's
// best-effort — see spec § 5.2.
const HISTORY_REPLAY_BUFFER_HINT = 1000;

type ConsoleApiLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';
type OutputLevel = ConsoleApiLevel | 'exception';

interface RemoteObject {
  type: string;
  subtype?: string;
  className?: string;
  description?: string;
  value?: unknown;
}

interface ConsoleApiCalledParams {
  type: string; // 'log' | 'info' | 'warning' | 'error' | 'debug' | ...
  args: RemoteObject[];
  executionContextId: number;
  timestamp: number; // ms since epoch (CDP MonotonicTime is seconds; here it's documented ms)
  stackTrace?: { callFrames: { url: string; lineNumber: number; columnNumber: number }[] };
}

interface ExceptionThrownParams {
  timestamp: number;
  exceptionDetails: {
    text?: string;
    url?: string;
    lineNumber?: number;
    columnNumber?: number;
    exception?: RemoteObject;
    stackTrace?: { callFrames: { url: string; lineNumber: number; columnNumber: number }[] };
  };
}

interface LogEntryAddedParams {
  entry: {
    source: string;
    level: 'verbose' | 'info' | 'warning' | 'error';
    text: string;
    timestamp: number;
    url?: string;
    lineNumber?: number;
    stackTrace?: { callFrames: { url: string; lineNumber: number; columnNumber: number }[] };
  };
}

interface CollectedLog {
  level: OutputLevel;
  text: string;
  source?: string;
  lineno?: number;
  colno?: number;
  timestamp: number;
  stackTrace?: string;
}

function stringifyArg(arg: RemoteObject): string {
  // Match Chrome DevTools' compact display:
  //   primitives → value
  //   objects   → description (e.g. 'Object', 'Array(3)') or className
  if (arg.type === 'string') return String(arg.value);
  if (arg.type === 'number' || arg.type === 'boolean' || arg.type === 'undefined') {
    return String(arg.value);
  }
  if (arg.type === 'symbol') return arg.description ?? 'Symbol()';
  if (arg.value !== undefined && (arg.type === 'bigint' || typeof arg.value !== 'object')) {
    return String(arg.value);
  }
  return arg.description ?? arg.className ?? arg.type;
}

function flattenStack(st?: { callFrames: { url: string; lineNumber: number; columnNumber: number }[] }): string | undefined {
  if (!st || !st.callFrames || st.callFrames.length === 0) return undefined;
  return st.callFrames
    .map((f) => `    at ${f.url}:${f.lineNumber + 1}:${f.columnNumber + 1}`)
    .join('\n');
}

function mapApiTypeToLevel(t: string): ConsoleApiLevel | null {
  switch (t) {
    case 'log':
    case 'info':
    case 'debug':
    case 'error':
      return t;
    case 'warning':
      return 'warn';
    // 'dir' / 'dirxml' / 'table' / 'trace' / 'clear' / 'startGroup' / etc. — drop
    default:
      return null;
  }
}

function mapLogEntryLevel(l: LogEntryAddedParams['entry']['level']): ConsoleApiLevel {
  switch (l) {
    case 'verbose':
      return 'debug';
    case 'info':
      return 'info';
    case 'warning':
      return 'warn';
    case 'error':
      return 'error';
  }
}

export async function handleGetConsoleLogs(rawParams: unknown): Promise<unknown> {
  const params = GetConsoleLogsInput.parse(rawParams);

  // ----- resolve tab -----
  if (params.url) {
    const guard = checkUrlAllowed(params.url);
    if (!guard.ok) return urlForbiddenError(guard.reason);
  }
  const tab = await openOrReuse({ url: params.url, tabId: params.tabId });

  // ----- attach -----
  const { session, reason } = await tryAttachToTab(tab.tabId);
  if (!session) {
    if (!tab.reused) await tab.cleanup();
    if (reason === 'special_page') {
      return {
        error: 'url_forbidden',
        message: 'Cannot read console on special pages (chrome://, devtools://, etc.).',
        hint: 'Pass a regular http(s):// url, or switch to a non-special tab.',
      };
    }
    if (reason === 'tab_gone') {
      return { error: 'tab_closed', message: 'Tab was closed before console snapshot could attach.' };
    }
    return {
      error: 'cdp_attach_failed',
      message: 'Could not attach Chrome debugger after 3 retries.',
      hint: 'Close DevTools (F12) on the target tab and retry.',
    };
  }

  const collected: CollectedLog[] = [];
  let consoleApiHistoryCount = 0;
  const wantedLevels = new Set<ConsoleApiLevel>(params.level);

  // chrome.debugger.onEvent fires with (source, method, params). We must
  // attach + later detach the listener to avoid leaking it across calls.
  const onEvent = (
    source: chrome.debugger.Debuggee,
    method: string,
    cdpParams?: unknown,
  ): void => {
    if (source.tabId !== tab.tabId) return;
    if (method === 'Runtime.consoleAPICalled') {
      const p = cdpParams as ConsoleApiCalledParams;
      consoleApiHistoryCount += 1;
      const lvl = mapApiTypeToLevel(p.type);
      if (lvl === null) return;
      if (!wantedLevels.has(lvl)) return;
      const text = (p.args ?? []).map(stringifyArg).join(' ');
      const frame0 = p.stackTrace?.callFrames?.[0];
      collected.push({
        level: lvl,
        text,
        source: frame0?.url,
        lineno: frame0 ? frame0.lineNumber + 1 : undefined,
        colno: frame0 ? frame0.columnNumber + 1 : undefined,
        timestamp: Math.round(p.timestamp),
        stackTrace: lvl === 'error' ? flattenStack(p.stackTrace) : undefined,
      });
    } else if (method === 'Runtime.exceptionThrown' && params.includeExceptions) {
      const p = cdpParams as ExceptionThrownParams;
      const d = p.exceptionDetails;
      const text =
        d.text ??
        (d.exception ? stringifyArg(d.exception) : 'Uncaught exception');
      collected.push({
        level: 'exception',
        text,
        source: d.url,
        lineno: typeof d.lineNumber === 'number' ? d.lineNumber + 1 : undefined,
        colno: typeof d.columnNumber === 'number' ? d.columnNumber + 1 : undefined,
        timestamp: Math.round(p.timestamp),
        stackTrace: flattenStack(d.stackTrace),
      });
    } else if (method === 'Log.entryAdded') {
      const p = cdpParams as LogEntryAddedParams;
      const lvl = mapLogEntryLevel(p.entry.level);
      if (!wantedLevels.has(lvl)) return;
      collected.push({
        level: lvl,
        text: p.entry.text,
        source: p.entry.url,
        lineno: typeof p.entry.lineNumber === 'number' ? p.entry.lineNumber + 1 : undefined,
        colno: undefined,
        timestamp: Math.round(p.entry.timestamp),
        stackTrace: lvl === 'error' ? flattenStack(p.entry.stackTrace) : undefined,
      });
    }
  };
  chrome.debugger.onEvent.addListener(onEvent);

  try {
    // Runtime.enable replays buffered consoleAPICalled / exceptionThrown
    // events synchronously after enable. Log.enable mirrors that for the
    // browser-layer Log domain (network errors, deprecations, mixed content).
    await session.send('Runtime.enable', {});
    try {
      await session.send('Log.enable', {});
    } catch (e) {
      // Some Chrome versions reject Log.enable silently — best effort, see spec § 11.
      console.warn('[byob/get-console-logs] Log.enable failed (best-effort):', e);
    }

    // Wait the user-configured flush window (capped 5s by schema).
    await new Promise((r) => setTimeout(r, params.flushDelayMs));

    const tabInfo = await chrome.tabs.get(tab.tabId);
    // Sort oldest-first for readable output.
    collected.sort((a, b) => a.timestamp - b.timestamp);

    return {
      logs: collected,
      truncated: consoleApiHistoryCount >= HISTORY_REPLAY_BUFFER_HINT,
      tabId: tab.tabId,
      url: tabInfo.url ?? params.url ?? '',
    };
  } finally {
    chrome.debugger.onEvent.removeListener(onEvent);
    if (!tab.reused) {
      await session.detach();
      await tab.cleanup();
    }
  }
}
```

- [ ] **Step 5.2: Typecheck**

Run:

```sh
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
cd /Users/wxt/code/byob && bun --cwd packages/extension run typecheck
```

Expected: typecheck exits 0. (WXT's typecheck script runs `wxt prepare` first to generate `.wxt/types/`.)

- [ ] **Step 5.3: Commit**

Tell user to run:

```bash
git add packages/extension/lib/handlers/get-console-logs.ts
git commit -m "$(cat <<'EOF'
feat(extension): handler for browser_get_console_logs

CDP snapshot-mode handler: attaches Runtime + Log domains, replays buffered
console events for flushDelayMs (default 200ms, capped 5s), maps CDP levels
to public schema levels, and detaches. Output 'exception' level is gated by
includeExceptions independently from the input level filter (spec § 4.1).
truncated flag is the spec-defined heuristic — replay count >= 1000.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: extension handler — read-markdown.ts

**Files:**
- Create: `/Users/wxt/code/byob/packages/extension/lib/handlers/read-markdown.ts`

Flow:
1. Resolve tab via `openOrReuse`.
2. Pull `outerHTML` via `chrome.scripting.executeScript({ world: 'ISOLATED' })` — DOM is shared between worlds; isolated world avoids page globals & CSP traps. (CDP attach is **not** required for this path; we don't need debugger privileges to read DOM via scripting.)
3. POST `{ html, sourceUrl, options }` to `readabilityEndpoint?secret=...` (bridge passes the endpoint + secret in params).
4. Map response to handler return shape.

- [ ] **Step 6.1: Write the handler**

Create `/Users/wxt/code/byob/packages/extension/lib/handlers/read-markdown.ts`:

```ts
import { ReadMarkdownInput } from '@byob/shared';
import { openOrReuse } from '../tab.js';
import { checkUrlAllowed, urlForbiddenError } from '../url-guard.js';
import { keepAwakeStart, keepAwakeEnd } from '../keepalive.js';

// Function that runs in the page's ISOLATED world (default). Returns the
// full document HTML so the bridge can do Readability extraction.
function snapshotOuterHtmlInPage(): { url: string; outerHTML: string } {
  return {
    url: location.href,
    outerHTML: document.documentElement?.outerHTML ?? '',
  };
}

interface ReadabilityServerOk {
  ok: true;
  markdown: string;
  title?: string;
  byline?: string;
  excerpt?: string;
  lengthChars: number;
  truncated?: boolean;
}
interface ReadabilityServerErr {
  ok: false;
  code: 'readability_no_article' | 'html_parse_failed';
  htmlLength?: number;
  message?: string;
}

export async function handleReadMarkdown(rawParams: unknown): Promise<unknown> {
  const params = ReadMarkdownInput.parse(rawParams);

  // Bridge enriches params with these two before forwarding (see main.ts
  // readMarkdownRoute). Without them we cannot reach the local /readability
  // endpoint.
  const extra = rawParams as { readabilityEndpoint?: string; readabilitySecret?: string };
  const endpoint = typeof extra.readabilityEndpoint === 'string' ? extra.readabilityEndpoint : '';
  const secret = typeof extra.readabilitySecret === 'string' ? extra.readabilitySecret : '';
  if (!endpoint || !secret) {
    return {
      error: 'unknown',
      message: 'bridge did not provide readabilityEndpoint/readabilitySecret',
    };
  }

  if (params.url) {
    const guard = checkUrlAllowed(params.url);
    if (!guard.ok) return urlForbiddenError(guard.reason);
  }
  const tab = await openOrReuse({ url: params.url, tabId: params.tabId });

  keepAwakeStart();
  try {
    // Fetch outerHTML via chrome.scripting (no CDP attach needed for DOM read).
    let snapshot: { url: string; outerHTML: string } | null = null;
    try {
      const [exec] = await chrome.scripting.executeScript({
        target: { tabId: tab.tabId },
        world: 'ISOLATED',
        func: snapshotOuterHtmlInPage,
      });
      snapshot = (exec?.result as { url: string; outerHTML: string } | null) ?? null;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Common cause: tab is on chrome:// or moved off page mid-call.
      if (/Cannot access|chrome-extension|Frame|target/i.test(msg)) {
        return {
          error: 'url_forbidden',
          message:
            'Cannot read markdown on special pages or pages where scripting is blocked.',
          hint: 'Use a regular http(s):// url.',
        };
      }
      return {
        error: 'unknown',
        message: `executeScript failed: ${msg}`,
      };
    }
    if (!snapshot || !snapshot.outerHTML) {
      return {
        error: 'html_parse_failed',
        message: 'Could not read page HTML (empty document).',
      };
    }

    // POST to bridge /readability endpoint via loopback HTTP (CSP/CORS handled
    // by the bridge upload-server). Same pattern as download-images.
    const url = endpoint + '?secret=' + encodeURIComponent(secret);
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          html: snapshot.outerHTML,
          sourceUrl: snapshot.url,
          options: {
            includeMetadata: params.includeMetadata,
            includeImages: params.includeImages,
            preserveCode: params.preserveCode,
            maxLength: params.maxLength,
          },
        }),
      });
    } catch (e) {
      return {
        error: 'unknown',
        message: `fetch /readability failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    const data = (await resp.json()) as ReadabilityServerOk | ReadabilityServerErr;
    if (!data.ok) {
      if (data.code === 'readability_no_article') {
        return {
          error: 'readability_no_article',
          message: `Readability did not identify a main article (htmlLength=${data.htmlLength ?? 0}).`,
          hint: 'Fall back to browser_read for noisy / SPA pages.',
        };
      }
      return {
        error: 'html_parse_failed',
        message: data.message ?? 'HTML parse failed',
      };
    }

    const tabInfo = await chrome.tabs.get(tab.tabId);
    const out: Record<string, unknown> = {
      markdown: data.markdown,
      lengthChars: data.lengthChars,
      tabId: tab.tabId,
      url: tabInfo.url ?? snapshot.url,
    };
    if (params.includeMetadata) {
      if (data.title !== undefined) out.title = data.title;
      if (data.byline !== undefined) out.byline = data.byline;
      if (data.excerpt !== undefined) out.excerpt = data.excerpt;
    }
    if (data.truncated) out.truncated = true;
    return out;
  } finally {
    keepAwakeEnd();
    if (!tab.reused) {
      await tab.cleanup();
    }
  }
}
```

- [ ] **Step 6.2: Typecheck**

Run:

```sh
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
cd /Users/wxt/code/byob && bun --cwd packages/extension run typecheck
```

Expected: typecheck exits 0.

- [ ] **Step 6.3: Commit**

Tell user to run:

```bash
git add packages/extension/lib/handlers/read-markdown.ts
git commit -m "$(cat <<'EOF'
feat(extension): handler for browser_read_markdown

Snapshots document.documentElement.outerHTML via chrome.scripting in the
ISOLATED world (no CDP needed for DOM read), then POSTs the HTML to the
bridge-side /readability loopback endpoint for jsdom + Readability + turndown
conversion. Maps server { code:'readability_no_article'|'html_parse_failed' }
errors to typed envelopes with debugging hints.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: extension handler — extract-table.ts

**Files:**
- Create: `/Users/wxt/code/byob/packages/extension/lib/handlers/extract-table.ts`

Pure DOM walker via `chrome.scripting.executeScript` — no CDP, no bridge round-trip. Page-side code uses `innerText` (visual), falls back to `textContent` if the renderer hasn't computed `innerText`. 0 matches returns `tables: []` (not an error).

- [ ] **Step 7.1: Write the handler**

Create `/Users/wxt/code/byob/packages/extension/lib/handlers/extract-table.ts`:

```ts
import { ExtractTableInput } from '@byob/shared';
import { openOrReuse } from '../tab.js';
import { checkUrlAllowed, urlForbiddenError } from '../url-guard.js';

export interface ExtractedTable {
  selector: string;
  headers: string[];
  rows: string[][] | Record<string, string>[];
  rowCount: number;
}

// Runs in the page's ISOLATED world. Pure: no closures over outer vars.
function extractTablesInPage(
  selector: string,
  format: 'rows' | 'objects',
): { selector: string; headers: string[]; rows: unknown[]; rowCount: number }[] {
  function cellText(el: Element): string {
    // innerText reflects visual layout (handles display:none, <br>, etc.)
    // but is undefined in headless / non-rendered contexts. textContent is
    // a safe fallback and trims any \n.
    const v = (el as HTMLElement).innerText;
    const t = typeof v === 'string' && v.length > 0 ? v : el.textContent ?? '';
    return t.replace(/\s+/g, ' ').trim();
  }

  function rowCells(tr: Element): string[] {
    const out: string[] = [];
    const cells = tr.querySelectorAll(':scope > th, :scope > td');
    for (const c of cells) out.push(cellText(c));
    return out;
  }

  const tables = document.querySelectorAll(selector);
  const out: { selector: string; headers: string[]; rows: unknown[]; rowCount: number }[] = [];
  let i = 0;
  for (const t of tables) {
    if (!(t instanceof HTMLTableElement)) {
      // selector matched something that isn't <table> — skip silently.
      continue;
    }
    // Headers: prefer <thead> first row's <th>; else first <tr> in the table.
    let headerCells: string[] = [];
    const theadTr = t.querySelector(':scope > thead > tr');
    if (theadTr) {
      headerCells = rowCells(theadTr);
    }
    // Body rows: <tbody> first if present; otherwise all direct <tr> minus
    // the row we treated as header.
    const bodyTrs: Element[] = [];
    const tbodies = t.querySelectorAll(':scope > tbody');
    if (tbodies.length > 0) {
      for (const tb of tbodies) {
        for (const tr of tb.querySelectorAll(':scope > tr')) bodyTrs.push(tr);
      }
    } else {
      const trs = Array.from(t.querySelectorAll(':scope > tr'));
      if (headerCells.length === 0 && trs.length > 0 && trs[0]) {
        // No <thead>: pull the first row as headers.
        headerCells = rowCells(trs[0]);
        for (let k = 1; k < trs.length; k++) bodyTrs.push(trs[k]!);
      } else {
        for (const tr of trs) bodyTrs.push(tr);
      }
    }

    const rawRows: string[][] = bodyTrs.map(rowCells);

    let rows: unknown[];
    if (format === 'objects' && headerCells.length > 0) {
      rows = rawRows.map((r) => {
        const o: Record<string, string> = {};
        for (let c = 0; c < headerCells.length; c++) {
          const key = headerCells[c] ?? `col${c}`;
          o[key] = r[c] ?? '';
        }
        return o;
      });
    } else {
      rows = rawRows;
    }

    // Best-effort selector that uniquely identifies which match this is.
    // Wikipedia-style multi-table pages usually only need :nth-of-type to
    // disambiguate; we always include the index.
    out.push({
      selector: `${selector}:nth-of-type(${i + 1})`,
      headers: headerCells,
      rows,
      rowCount: rawRows.length,
    });
    i += 1;
  }
  return out;
}

export async function handleExtractTable(rawParams: unknown): Promise<unknown> {
  const params = ExtractTableInput.parse(rawParams);

  if (params.url) {
    const guard = checkUrlAllowed(params.url);
    if (!guard.ok) return urlForbiddenError(guard.reason);
  }
  const tab = await openOrReuse({ url: params.url, tabId: params.tabId });

  try {
    let result: ExtractedTable[] = [];
    try {
      const [exec] = await chrome.scripting.executeScript({
        target: { tabId: tab.tabId },
        world: 'ISOLATED',
        func: extractTablesInPage,
        args: [params.selector, params.format],
      });
      result = (exec?.result as ExtractedTable[] | undefined) ?? [];
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/Cannot access|chrome-extension|Frame|target/i.test(msg)) {
        return {
          error: 'url_forbidden',
          message:
            'Cannot extract tables on special pages or pages where scripting is blocked.',
          hint: 'Use a regular http(s):// url.',
        };
      }
      return {
        error: 'unknown',
        message: `executeScript failed: ${msg}`,
      };
    }

    const tabInfo = await chrome.tabs.get(tab.tabId);
    return {
      tables: result,
      tabId: tab.tabId,
      url: tabInfo.url ?? params.url ?? '',
    };
  } finally {
    if (!tab.reused) {
      await tab.cleanup();
    }
  }
}
```

- [ ] **Step 7.2: Typecheck**

Run:

```sh
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
cd /Users/wxt/code/byob && bun --cwd packages/extension run typecheck
```

Expected: typecheck exits 0.

- [ ] **Step 7.3: Commit**

Tell user to run:

```bash
git add packages/extension/lib/handlers/extract-table.ts
git commit -m "$(cat <<'EOF'
feat(extension): handler for browser_extract_table

Pure DOM walker run via chrome.scripting in the ISOLATED world: querySelectorAll
on selector, header detection (thead → first <tr> fallback), body row collection
(tbody first, else direct <tr>), innerText-with-textContent-fallback for cells.
format='objects' pairs cells with header names. 0 matches returns tables:[]
not an error (spec § 4.3). colspan/rowspan are NOT expanded — documented limit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: extension dispatcher — register 3 handlers

**Files:**
- Modify: `/Users/wxt/code/byob/packages/extension/lib/handlers/index.ts`

- [ ] **Step 8.1: Update handlers/index.ts**

Replace the entire contents of `/Users/wxt/code/byob/packages/extension/lib/handlers/index.ts` with:

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
import { handleGetConsoleLogs } from './get-console-logs.js';
import { handleReadMarkdown } from './read-markdown.js';
import { handleExtractTable } from './extract-table.js';

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
  [Command.GetConsoleLogs]: handleGetConsoleLogs,
  [Command.ReadMarkdown]: handleReadMarkdown,
  [Command.ExtractTable]: handleExtractTable,
};
```

- [ ] **Step 8.2: Typecheck**

Run:

```sh
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
cd /Users/wxt/code/byob && bun --cwd packages/extension run typecheck
```

Expected: typecheck exits 0.

- [ ] **Step 8.3: Commit**

Tell user to run:

```bash
git add packages/extension/lib/handlers/index.ts
git commit -m "$(cat <<'EOF'
feat(extension): wire 3 new handlers into dispatcher

Registers get-console-logs, read-markdown, extract-table in the command map
so background.ts can dispatch incoming NM frames. No behavior change to
existing 11 commands.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: mcp-server tool — browser-get-console-logs.ts

**Files:**
- Create: `/Users/wxt/code/byob/packages/mcp-server/src/tools/browser-get-console-logs.ts`

- [ ] **Step 9.1: Write the tool registration**

Create `/Users/wxt/code/byob/packages/mcp-server/src/tools/browser-get-console-logs.ts`:

```ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GetConsoleLogsInputRaw, GetConsoleLogsOutput } from '@byob/shared';
import { bridgePost } from '../bridge-client.js';
import { asErrorEnvelope, toMcpError } from '../error-mapper.js';

export function registerBrowserGetConsoleLogs(server: McpServer): void {
  server.registerTool(
    'browser_get_console_logs',
    {
      title: 'Snapshot console output and JS exceptions from a page',
      description:
        "Read recent console.log/info/warn/error/debug entries plus uncaught JavaScript " +
        "exceptions from a tab in the user's real Chrome. Snapshot only — does not stream. " +
        "Useful for debugging frontend issues an AI agent is iterating on. Default level " +
        "filter is ['warn','error']; set includeExceptions:false to skip uncaught throws. " +
        'Pass either url (opens a tab) or tabId (existing tab).',
      inputSchema: GetConsoleLogsInputRaw.shape,
    },
    async (args) => {
      const { status, body } = await bridgePost('/get-console-logs', args);
      if (status >= 400) return toMcpError(asErrorEnvelope(body, `bridge ${status}`));
      const parsed = GetConsoleLogsOutput.safeParse(body);
      if (!parsed.success) return toMcpError({ error: 'unknown', message: parsed.error.message });
      return { content: [{ type: 'text', text: JSON.stringify(parsed.data) }] };
    },
  );
}
```

- [ ] **Step 9.2: Commit (after Task 11 below also done — same logical change set)**

We commit all 3 mcp-server tools together at the end of Task 11. Skip commit step here.

---

## Task 10: mcp-server tool — browser-read-markdown.ts

**Files:**
- Create: `/Users/wxt/code/byob/packages/mcp-server/src/tools/browser-read-markdown.ts`

- [ ] **Step 10.1: Write the tool registration**

Create `/Users/wxt/code/byob/packages/mcp-server/src/tools/browser-read-markdown.ts`:

```ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ReadMarkdownInputRaw, ReadMarkdownOutput } from '@byob/shared';
import { bridgePost } from '../bridge-client.js';
import { asErrorEnvelope, toMcpError } from '../error-mapper.js';

export function registerBrowserReadMarkdown(server: McpServer): void {
  server.registerTool(
    'browser_read_markdown',
    {
      title: 'Read a webpage as clean markdown (article-mode)',
      description:
        'Open a URL or use an existing tab and convert the main article body to markdown using ' +
        "Mozilla Readability + turndown. Strips navigation / sidebars / ads / footer. Returns " +
        'title, byline, excerpt + the markdown body. Best for news, blog posts, docs. SPA-heavy ' +
        'sites may fail Readability — fall back to browser_read in that case.',
      inputSchema: ReadMarkdownInputRaw.shape,
    },
    async (args) => {
      const { status, body } = await bridgePost('/read-markdown', args);
      if (status >= 400) return toMcpError(asErrorEnvelope(body, `bridge ${status}`));
      const parsed = ReadMarkdownOutput.safeParse(body);
      if (!parsed.success) return toMcpError({ error: 'unknown', message: parsed.error.message });
      return { content: [{ type: 'text', text: JSON.stringify(parsed.data) }] };
    },
  );
}
```

- [ ] **Step 10.2: (commit happens at end of Task 11)**

Skip commit step here.

---

## Task 11: mcp-server tool — browser-extract-table.ts + register all

**Files:**
- Create: `/Users/wxt/code/byob/packages/mcp-server/src/tools/browser-extract-table.ts`
- Modify: `/Users/wxt/code/byob/packages/mcp-server/src/tools/index.ts`

- [ ] **Step 11.1: Write the tool registration**

Create `/Users/wxt/code/byob/packages/mcp-server/src/tools/browser-extract-table.ts`:

```ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ExtractTableInputRaw, ExtractTableOutput } from '@byob/shared';
import { bridgePost } from '../bridge-client.js';
import { asErrorEnvelope, toMcpError } from '../error-mapper.js';

export function registerBrowserExtractTable(server: McpServer): void {
  server.registerTool(
    'browser_extract_table',
    {
      title: 'Extract <table> elements from a page as JSON',
      description:
        "Walk every <table> matching a CSS selector (default 'table') in the user's real " +
        "Chrome and return cells as JSON. format='rows' returns string[][]; format='objects' " +
        'pairs each row with the header row to give Record<string,string>[]. 0 matches is ' +
        'not an error — returns tables:[]. Does NOT expand colspan/rowspan and does NOT ' +
        'support ARIA `role="table"` divs (use browser_read for those).',
      inputSchema: ExtractTableInputRaw.shape,
    },
    async (args) => {
      const { status, body } = await bridgePost('/extract-table', args);
      if (status >= 400) return toMcpError(asErrorEnvelope(body, `bridge ${status}`));
      const parsed = ExtractTableOutput.safeParse(body);
      if (!parsed.success) return toMcpError({ error: 'unknown', message: parsed.error.message });
      return { content: [{ type: 'text', text: JSON.stringify(parsed.data) }] };
    },
  );
}
```

- [ ] **Step 11.2: Register all 3 tools**

Replace the entire contents of `/Users/wxt/code/byob/packages/mcp-server/src/tools/index.ts` with:

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
import { registerBrowserGetConsoleLogs } from './browser-get-console-logs.js';
import { registerBrowserReadMarkdown } from './browser-read-markdown.js';
import { registerBrowserExtractTable } from './browser-extract-table.js';

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
  registerBrowserGetConsoleLogs(server);
  registerBrowserReadMarkdown(server);
  registerBrowserExtractTable(server);
  if (process.env.BYOB_ALLOW_EVAL === '1') {
    registerBrowserEval(server);
    console.error('[byob-mcp] browser_eval ENABLED via BYOB_ALLOW_EVAL=1');
  }
}
```

- [ ] **Step 11.3: Typecheck**

Run:

```sh
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
cd /Users/wxt/code/byob && bun --cwd packages/mcp-server run typecheck
```

Expected: typecheck exits 0.

- [ ] **Step 11.4: Commit (covers Tasks 9, 10, 11)**

Tell user to run:

```bash
git add packages/mcp-server/src/tools/browser-get-console-logs.ts packages/mcp-server/src/tools/browser-read-markdown.ts packages/mcp-server/src/tools/browser-extract-table.ts packages/mcp-server/src/tools/index.ts
git commit -m "$(cat <<'EOF'
feat(mcp-server): register browser_get_console_logs / read_markdown / extract_table

Three new MCP tools wire to the bridge HTTP routes. Each uses the existing
bridgePost + error-mapper plumbing — no new infrastructure. inputSchema uses
the *Raw forms (un-refined ZodObject) because MCP's inputSchema field needs
.shape, and refinements would erase it.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: full workspace typecheck + e2e checklist update

**Files:**
- Modify: `/Users/wxt/code/byob/docs/e2e-checklist.md`

- [ ] **Step 12.1: Run workspace typecheck**

Run:

```sh
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
cd /Users/wxt/code/byob && bun run typecheck
```

Expected: 4 packages all green (`shared`, `extension`, `bridge`, `mcp-server`). If anything red, stop and fix before proceeding.

- [ ] **Step 12.2: Append e2e items**

Edit `/Users/wxt/code/byob/docs/e2e-checklist.md`. Append at the end of the file (after the last `- [ ]` line in "Polish"):

```markdown

## v0.2 read-tools trio (sub-project A)

### `browser_get_console_logs`

- [ ] On `https://example.com`, run `browser_eval "console.error('test'); console.warn('w'); throw new Error('boom')"` then `browser_get_console_logs` (same tab) — expect 3 entries: 1× error, 1× warn, 1× exception with stackTrace
- [ ] Same tab, call `browser_get_console_logs level: ['error']` — exception still appears (independent flag), warn does not
- [ ] Same tab, call `browser_get_console_logs level: ['error'] includeExceptions: false` — only the error entry; no exception
- [ ] On `chrome://settings` — expect `url_forbidden` envelope with hint

### `browser_read_markdown`

- [ ] On a BBC News article — markdown contains the headline, lengthChars > 500, byline non-empty, no `<nav>` / footer text
- [ ] On `https://x.com/anthropic` (heavy SPA) — expect either a usable result OR `readability_no_article` envelope with htmlLength field; never crash
- [ ] Same BBC article with `includeImages: false` — markdown contains zero `![` substrings
- [ ] Same BBC article with `maxLength: 200` — markdown ends with `\n\n[truncated]\n`, `truncated: true`

### `browser_extract_table`

- [ ] On `https://en.wikipedia.org/wiki/List_of_countries_by_population_(United_Nations)` with default `selector: 'table'` and `format: 'objects'` — at least one returned table; first row has key names matching first column header (e.g. "Country / Dependency"); rowCount >= 50
- [ ] Same URL with `selector: 'table.sortable'` and `format: 'rows'` — rows are `string[][]` not `Record<string,string>[]`
- [ ] On a page with no tables (e.g. `https://example.com`) — `tables: []`, no error
```

- [ ] **Step 12.3: Commit**

Tell user to run:

```bash
git add docs/e2e-checklist.md
git commit -m "$(cat <<'EOF'
docs(e2e): add 10 manual checks for v0.2 read-tools trio

Covers the 3 new tools' happy paths and key error envelopes.
get-console-logs: level filter / includeExceptions independence / forbidden
URL. read-markdown: BBC happy path / SPA failure / image filter / maxLength
truncation. extract-table: Wikipedia objects / rows mode / 0-match.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: manual verification (run e2e items)

**Files:** none (this is a runtime check)

This task does **not** produce a commit. It exists so the subagent / user runs the actual byob installation and sanity-checks the new tools end-to-end before declaring the plan done.

- [ ] **Step 13.1: Build the extension**

Run:

```sh
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
cd /Users/wxt/code/byob && bun --cwd packages/extension run build
```

Expected: `.output/chrome-mv3/` updated. (If you previously had `bun --cwd packages/extension run dev` running, that's already live-reloaded.)

- [ ] **Step 13.2: Reload extension + restart Chrome (if dev mode not running)**

In Chrome go to `chrome://extensions`, click reload on the byob extension. The bridge will re-spawn on the next NM frame.

- [ ] **Step 13.3: Verify bridge is healthy**

Run:

```sh
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
cd /Users/wxt/code/byob && bun --cwd packages/bridge run dev:cli doctor
```

Expected: all 4 lines `✓` — manifest, launcher, bridge process, extension connection.

- [ ] **Step 13.4: Run the 10 e2e checks from Task 12.2**

Walk through each `- [ ]` in the new "v0.2 read-tools trio" section of `docs/e2e-checklist.md`. Tick them as they pass. If any fail, capture the error envelope and fix the root cause before declaring done.

- [ ] **Step 13.5: No commit. Report results.**

Tell the user which checks passed / failed. Do **not** automatically tag a release.

---

## Self-Review Notes

- **Spec coverage** (mapped to spec sections):
  - § 4.1 Input/Output `get_console_logs` — Task 1 (schema), Task 5 (handler)
  - § 4.2 Input/Output `read_markdown` — Task 1, Task 2 (server), Task 3 (route), Task 4 (bridge route), Task 6 (handler)
  - § 4.3 Input/Output `extract_table` — Task 1, Task 7 (handler)
  - § 5.1 Reuse infrastructure — Tasks 5/6/7 reuse `openOrReuse`, `tryAttachToTab`, `checkUrlAllowed`, `keepAwakeStart/End` (read-markdown only — extract/console-logs don't need keepAwake since they're <250ms)
  - § 5.2 console_logs flow + truncated heuristic — Task 5 (HISTORY_REPLAY_BUFFER_HINT = 1000)
  - § 5.3 read_markdown flow extension→bridge — Tasks 3/4/6 with /readability secret-gated
  - § 5.4 extract_table page-side walker — Task 7 (`extractTablesInPage` runs in ISOLATED world; `:scope > th, :scope > td`)
  - § 6 shared schema changes — Task 1
  - § 7 mcp-server changes — Tasks 9/10/11
  - § 8 bridge changes — Tasks 2/3/4
  - § 9 error handling — Tasks 5/6/7 map all listed cases (forbidden_url, bad_input via Zod, tab_not_found via openOrReuse throw, cdp_attach_failed via tryAttachToTab, html_parse_failed + readability_no_article in Tasks 3/6, 0-table in Task 7)
  - § 10 testing — Task 1 (schema unit), Task 2 (converter unit), Task 12 (e2e)
  - § 11 risks — best-effort `Log.enable` swallows error in Task 5; readability_no_article includes htmlLength in Tasks 3/6

- **Dispatch envelope safety:** New handlers in Tasks 5/6/7 each return objects with `level`, `markdown`, `tables`, etc. — none use a top-level `type` or `requestId` key, satisfying HANDOFF.md decision #4.

- **chrome.scripting permission already declared** in `packages/extension/wxt.config.ts` (`'scripting'`). No manifest change needed for read-markdown / extract-table.

- **Future-proof signatures:** Each handler keeps `params: unknown` shape so adding `framePath` (sub-project D) is one Zod field + one `executeScript({ target: { tabId, frameIds }})` plumbing change later. Handlers don't share state across calls so AbortSignal (sub-project B) plugs in via the bridge cancel envelope without rewriting these handlers.

- **Tasks 9/10/11 deliberately group into one commit** because each individual file is too small to commit in isolation but together they're a single logical unit ("MCP-server bindings for the trio").

- **Task 13 is intentionally not a commit** — it's the human verification gate before claiming done.
