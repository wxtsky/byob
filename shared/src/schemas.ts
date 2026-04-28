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

// ---------- Common: framePath mixin ----------
// Optional cross-frame addressing for tools that operate inside a specific
// iframe / nested frame. Each entry is a CSS selector matched against the
// current frame's document; the matched element must be an <iframe> or
// <frame>. An empty array (or omitted field) targets the main frame and
// preserves v0.1 behavior. See spec `2026-04-25-iframe-support-design.md`.
export const FramePathInput = z.object({
  framePath: z.array(z.string().min(1)).max(8).default([]),
});

// ---------- 1. browser_read ----------
export const ReadInput = z.object({
  url: z.string().url(),
  screens: z.number().int().min(1).max(50).default(3),
  timeoutSec: z.number().int().min(1).max(600).default(60),
  sessionId: z.string().optional(),
  reuseTab: z.boolean().default(false),
}).merge(FramePathInput);
// Interactive element index — populated by the in-page clickable-detector
// (see packages/extension/lib/clickable-detector.ts). Each entry has a
// monotonic 1-based `idx` that the agent can pass back to browser_click /
// browser_type via `selector: 'byob:idx=N'`. Indices are stable for the
// lifetime of a single page load; SPA re-renders or navigations invalidate
// them and the agent must re-run browser_read.
export const InteractiveElementSchema = z.object({
  idx: z.number().int(),
  tag: z.string(),
  role: z.string().optional(),
  name: z.string().optional(),
  bounds: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  inputType: z.string().optional(),
  href: z.string().optional(),
});
export type InteractiveElement = z.infer<typeof InteractiveElementSchema>;

export const ReadOutput = z.object({
  text: z.string(),
  title: z.string(),
  url: z.string(),
  chunks: z.array(ChunkSchema),
  sessionId: z.string(),
  canContinue: z.boolean(),
  stopReason: z.enum(['end_of_scroll', 'timeout', 'limit_reached', 'fallback']),
  interactiveElements: z.array(InteractiveElementSchema).optional(),
  // Per-page-load tag stamped onto the in-page idx counter. Change here
  // means a navigation / re-mount happened and your stashed idx values
  // are no longer valid — re-read before pointing browser_click at them.
  interactiveSessionTag: z.string().optional(),
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
  // Skip the elementFromPoint occlusion check before dispatching the click.
  // Default false (i.e. *do* check) — set true when you intentionally want
  // to click through an overlay you don't care about.
  force: z.boolean().default(false),
}).merge(FramePathInput);
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
}).merge(FramePathInput);
export const TypeOutput = z.object({ success: z.literal(true) });

// ---------- 5. browser_get_cookies ----------
// Raw shape (used by MCP inputSchema since ZodEffects has no .shape)
export const GetCookiesInputRaw = z.object({
  domain: z.string().optional(),
  url: z.string().url().optional(),
});
// With xor refinement for runtime parsing in handlers
export const GetCookiesInput = GetCookiesInputRaw.refine(
  (v) => v.domain || v.url,
  { message: 'either domain or url is required' },
);
export const CookieSchema = z.object({
  name: z.string(),
  value: z.string(),
  domain: z.string(),
  path: z.string(),
  expires: z.number().optional(),
  httpOnly: z.boolean(),
  secure: z.boolean(),
  // chrome.cookies.SameSiteStatus uses lowercase: 'no_restriction' | 'lax' | 'strict' | 'unspecified'
  // (CDP Network.getCookies returns capitalized 'Strict'/'Lax'/'None' — different API.)
  sameSite: z.enum(['no_restriction', 'lax', 'strict', 'unspecified']).optional(),
  partitionKey: z.string().optional(),
});
export const GetCookiesOutput = z.object({ cookies: z.array(CookieSchema) });

// ---------- 6. browser_eval ----------
export const EvalInput = z.object({
  code: z.string(),
  tabId: z.number().int().optional(),
  awaitPromise: z.boolean().default(true),
  returnByValue: z.boolean().default(true),
}).merge(FramePathInput);
export const EvalOutput = z.object({
  result: z.unknown(),
  // NB: name is `resultType` not `type` to avoid colliding with the
  // NM-protocol top-level `type:"result"` envelope field.
  resultType: z.string(),
  exceptionDetails: z.unknown().optional(),
  // v0.2: true when CDP attach failed and we executed via chrome.scripting.
  fallbackUsed: z.boolean().default(false),
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
}).merge(FramePathInput);
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

// ---------- 11. browser_download_images ----------
export const DownloadImagesInput = z.object({
  url: z.string().url(),
  saveDir: z.string().optional(),               // default: ~/.byob/downloads/<timestamp>/
  reuseTab: z.boolean().default(false),
  screens: z.number().int().min(0).max(50).default(5),     // scroll N screens to trigger lazy loaders
  timeoutSec: z.number().int().min(1).max(600).default(120),
  maxImages: z.number().int().min(1).max(500).default(50),
  minWidth: z.number().int().min(0).default(100),          // skip tiny icons by default
  minHeight: z.number().int().min(0).default(100),
  includeOgImage: z.boolean().default(true),    // also grab og:image / twitter:image meta
}).merge(FramePathInput);
export const DownloadedImageSchema = z.object({
  path: z.string(),                  // absolute local file path
  sourceUrl: z.string(),             // original <img src>
  filename: z.string(),
  size: z.number(),                  // bytes on disk
  width: z.number().optional(),      // naturalWidth
  height: z.number().optional(),
  contentType: z.string().optional(),
  bounds: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
  alt: z.string().optional(),
});
export const DownloadImagesOutput = z.object({
  saveDir: z.string(),
  page: z.object({
    url: z.string(),
    title: z.string(),
    viewport: z.object({ width: z.number(), height: z.number() }),
  }),
  images: z.array(DownloadedImageSchema),
  skipped: z.number(),               // how many candidates were filtered or failed
});

// ---------- Common: url-or-tabId base ----------
// Read-style tools (15+ below) take url XOR tabId. Express the xor as a
// refinement so handlers can rely on at-least-one being present. The vast
// majority of these inputs also accept `framePath`, so the
// `urlOrTabIdInput()` helper below bundles both.
export const UrlOrTabIdRaw = z.object({
  url: z.string().url().optional(),
  tabId: z.number().int().optional(),
});
function requireUrlOrTabId<T extends z.AnyZodObject>(schema: T) {
  return schema.refine((v) => v.url !== undefined || v.tabId !== undefined, {
    message: 'either url or tabId is required',
  });
}

/**
 * Canonical raw input shape for "tool that operates on a tab":
 * UrlOrTabIdRaw + FramePathInput + your extra fields. Hides
 * `.extend(...).merge(FramePathInput)` repetition. Pair with
 * `requireUrlOrTabId(...)` for the refined parser that handlers use.
 */
function urlOrTabIdInput<S extends z.ZodRawShape>(extra: S) {
  return UrlOrTabIdRaw.extend(extra).merge(FramePathInput);
}

/**
 * Same as urlOrTabIdInput but without FramePathInput. For the few tools
 * (browser_print_pdf, browser_get_performance, browser_intercept_start,
 * browser_emulate_device) where iframe addressing is either irrelevant or
 * actively rejected by the underlying CDP command.
 */
function urlOrTabIdInputNoFrame<S extends z.ZodRawShape>(extra: S) {
  return UrlOrTabIdRaw.extend(extra);
}

// ---------- 12. browser_get_console_logs ----------
export const GetConsoleLogsInputRaw = urlOrTabIdInput({
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
export const ReadMarkdownInputRaw = urlOrTabIdInput({
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
export const ExtractTableInputRaw = urlOrTabIdInput({
  selector: z.string().default('table'),
  format: z.enum(['rows', 'objects']).default('rows'),
});
export const ExtractTableInput = requireUrlOrTabId(ExtractTableInputRaw);
export const ExtractedTableSchema = z.object({
  selector: z.string(),
  headers: z.array(z.string()),
  rows: z.array(z.unknown()),
  rowCount: z.number().int(),
});
export const ExtractTableOutput = z.object({
  tables: z.array(ExtractedTableSchema),
  tabId: z.number().int(),
  url: z.string(),
});

// ---------- 15. browser_record_network ----------
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

// ---------- Internal: Cancel ----------
// HTTP body for POST /cancel on the bridge. requestId is the mcp-requestId
// generated by mcp-server. Bridge looks it up in its in-flight map.
export const CancelInput = z.object({
  requestId: z.string().min(1),
});
export type CancelInputType = z.infer<typeof CancelInput>;

// ---------- v0.3 Batch 1: 8 simple tools ----------

// ---------- 17. browser_scroll ----------
// `to`/`selector`/`y`/`text` 四选一（XOR）；用 superRefine 来表达。
// `text` is a substring match; the first text node containing it scrolls
// into view. Useful when you want to land on "Privacy Policy" without
// writing a CSS selector.
export const ScrollInputRaw = urlOrTabIdInput({
  to: z.enum(['top', 'bottom']).optional(),
  selector: z.string().optional(),
  y: z.number().optional(),
  text: z.string().min(1).optional(),
  behavior: z.enum(['auto', 'smooth']).default('auto'),
});
export const ScrollInput = requireUrlOrTabId(ScrollInputRaw).superRefine((v, ctx) => {
  const provided = [v.to, v.selector, v.y, v.text].filter((x) => x !== undefined).length;
  if (provided !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'exactly one of {to, selector, y, text} is required',
    });
  }
});
export const ScrollOutput = z.object({
  tabId: z.number().int(),
  url: z.string(),
  scrollY: z.number(),
  pageHeight: z.number(),
});

// ---------- 18. browser_press_key ----------
export const PressKeyInputRaw = urlOrTabIdInput({
  key: z.string().min(1),
  modifiers: z.array(z.enum(['Alt', 'Control', 'Shift', 'Meta'])).default([]),
});
export const PressKeyInput = requireUrlOrTabId(PressKeyInputRaw);
export const PressKeyOutput = z.object({
  tabId: z.number().int(),
  url: z.string(),
});

// ---------- 19. browser_select ----------
// `value`/`label`/`index` 三选一（XOR）。
export const SelectInputRaw = urlOrTabIdInput({
  selector: z.string().min(1),
  value: z.string().optional(),
  label: z.string().optional(),
  index: z.number().int().min(0).optional(),
});
export const SelectInput = requireUrlOrTabId(SelectInputRaw).superRefine((v, ctx) => {
  const provided = [v.value, v.label, v.index].filter((x) => x !== undefined).length;
  if (provided !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'exactly one of {value, label, index} is required',
    });
  }
});
export const SelectOutput = z.object({
  tabId: z.number().int(),
  url: z.string(),
  selectedValue: z.string(),
  selectedLabel: z.string(),
});

// ---------- 20. browser_close_tab ----------
export const CloseTabInput = z.object({
  tabId: z.number().int(),
});
export const CloseTabOutput = z.object({
  tabId: z.number().int(),
  closed: z.literal(true),
});

// ---------- 21. browser_go_back ----------
export const GoBackInput = z.object({
  tabId: z.number().int(),
  timeoutSec: z.number().int().min(1).max(600).default(30),
});
export const GoBackOutput = z.object({
  tabId: z.number().int(),
  url: z.string(),
  title: z.string(),
});

// ---------- 22. browser_go_forward ----------
export const GoForwardInput = z.object({
  tabId: z.number().int(),
  timeoutSec: z.number().int().min(1).max(600).default(30),
});
export const GoForwardOutput = z.object({
  tabId: z.number().int(),
  url: z.string(),
  title: z.string(),
});

// ---------- 23. browser_hover ----------
export const HoverInputRaw = urlOrTabIdInput({
  selector: z.string().min(1),
});
export const HoverInput = requireUrlOrTabId(HoverInputRaw);
export const HoverOutput = z.object({
  tabId: z.number().int(),
  url: z.string(),
});

// ---------- 24. browser_get_html ----------
export const GetHtmlInputRaw = urlOrTabIdInput({
  selector: z.string().default('html'),
  outerHtml: z.boolean().default(true),
  maxBytes: z.number().int().min(1).max(8 * 1024 * 1024).default(262144),
});
export const GetHtmlInput = requireUrlOrTabId(GetHtmlInputRaw);
export const GetHtmlOutput = z.object({
  tabId: z.number().int(),
  url: z.string(),
  html: z.string(),
  byteLength: z.number().int(),
  truncated: z.boolean(),
});

// ========================================================================
// v0.3 Batch 2: 5 medium-complexity tools
// ========================================================================

// ---------- 25. browser_set_cookies ----------
// chrome.cookies.SetDetails requires `url`. SameSite uses lowercase strings
// (chrome.cookies.SameSiteStatus); see commit c672b51 for the historical
// gotcha. partitionKey accepts a top-level site string (CHIPS); handler
// wraps it as { topLevelSite }.
export const SetCookiesInputRaw = z.object({
  url: z.string().url(),
  name: z.string().min(1),
  value: z.string(),
  domain: z.string().optional(),
  path: z.string().optional(),
  secure: z.boolean().optional(),
  httpOnly: z.boolean().optional(),
  sameSite: z.enum(['no_restriction', 'lax', 'strict']).optional(),
  expirationDate: z.number().optional(),
  partitionKey: z.string().optional(),
});
// `url` is required at the raw level, so no XOR refinement is needed
// (unlike the other 4 batch-2 inputs which use requireUrlOrTabId).
// SetCookiesInput is intentionally aliased to SetCookiesInputRaw.
export const SetCookiesInput = SetCookiesInputRaw;
export const SetCookiesOutput = z.object({
  ok: z.literal(true),
  cookie: CookieSchema,
});

// ---------- 26. browser_print_pdf ----------
// transferMode is forced to 'ReturnAsStream' in the handler; we don't expose
// it. Margin is a single number (inches, all four sides). paperFormat maps
// to paperWidth/paperHeight inches inside the handler.
export const PrintPdfInputRaw = urlOrTabIdInputNoFrame({
  savePath: z.string().optional(),
  paperFormat: z.enum(['A4', 'Letter', 'Legal']).default('A4'),
  landscape: z.boolean().default(false),
  printBackground: z.boolean().default(true),
  scale: z.number().min(0.1).max(2).default(1),
  margin: z.number().min(0).max(10).default(0.4),
  pageRanges: z.string().default(''),
});
export const PrintPdfInput = requireUrlOrTabId(PrintPdfInputRaw);
export const PrintPdfOutput = z.object({
  path: z.string(),
  byteLength: z.number().int(),
  tabId: z.number().int(),
  url: z.string(),
});

// ---------- 27. browser_get_storage ----------
// Output drops localStorage/sessionStorage fields when not requested.
// Truncation strategy: drop sessionStorage first, then trim localStorage
// keys in lexicographic order until under maxBytes.
export const GetStorageInputRaw = urlOrTabIdInput({
  kind: z.enum(['local', 'session', 'both']).default('both'),
  maxBytes: z.number().int().min(1024).max(8 * 1024 * 1024).default(1024 * 1024),
});
export const GetStorageInput = requireUrlOrTabId(GetStorageInputRaw);
export const GetStorageOutput = z.object({
  tabId: z.number().int(),
  url: z.string(),
  origin: z.string(),
  localStorage: z.record(z.string(), z.string()).optional(),
  sessionStorage: z.record(z.string(), z.string()).optional(),
  byteLength: z.number().int(),
  truncated: z.boolean(),
});

// ---------- 28. browser_get_performance ----------
// CWV indicators may be null when the page lacks the entry (no FCP yet, no
// user interaction so INP=null, no CLS layout shifts so CLS=null). The
// navigation entry is null only on chrome:// internal pages.
export const GetPerformanceInputRaw = urlOrTabIdInputNoFrame({
  waitMs: z.number().int().min(0).max(30_000).default(3000),
});
export const GetPerformanceInput = requireUrlOrTabId(GetPerformanceInputRaw);
// Navigation timing field semantics:
// - dnsLookup, tcpConnect: durations (end − start) in ms
// - requestStart, responseEnd, domContentLoaded, loadEvent: DOMHighResTimeStamp
//   values relative to navigationStart (ms since the navigation began)
// - transferSize, encodedBodySize: bytes
export const GetPerformanceOutput = z.object({
  tabId: z.number().int(),
  url: z.string(),
  webVitals: z.object({
    LCP: z.number().nullable(),
    CLS: z.number().nullable(),
    INP: z.number().nullable(),
    FCP: z.number().nullable(),
    TTFB: z.number().nullable(),
  }),
  navigation: z.object({
    domContentLoaded: z.number(),
    loadEvent: z.number(),
    dnsLookup: z.number(),
    tcpConnect: z.number(),
    requestStart: z.number(),
    responseEnd: z.number(),
    transferSize: z.number(),
    encodedBodySize: z.number(),
  }).nullable(),
});

// ---------- 29. browser_upload_file ----------
// `paths` are absolute paths on the host running the bridge; bridge route
// validates fs.access + path.isAbsolute before forwarding to the extension.
// Schema only does basic shape validation.
export const UploadFileInputRaw = urlOrTabIdInput({
  selector: z.string().min(1),
  paths: z.array(z.string().min(1)).min(1),
});
export const UploadFileInput = requireUrlOrTabId(UploadFileInputRaw);
export const UploadFileOutput = z.object({
  tabId: z.number().int(),
  url: z.string(),
  files: z.array(z.object({
    path: z.string(),
    name: z.string(),
    size: z.number().int(),
  })),
});

// ========================================================================
// v0.3 Batch 3: 4 commands across 3 complex tools (intercept_start,
// intercept_stop, drag, emulate_device)
// ========================================================================

// ---------- 30. browser_intercept_start ----------
// Stateful interception: each rule has a matcher (urlPattern XOR urlRegex,
// optional methods filter) and exactly one action (block / fulfill / modify
// / modifyResponse / passthrough). Action-specific args go in the matching
// optional sub-object.

const HttpMethod = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

// Plain ZodObject — used for MCP inputSchema descriptions (needs .shape).
const InterceptRuleObject = z
  .object({
    urlPattern: z.string().optional(),
    urlRegex: z.string().optional(),
    methods: z.array(HttpMethod).optional(),
    action: z.enum(['block', 'fulfill', 'modify', 'modifyResponse', 'passthrough']),
    block: z
      .object({
        errorReason: z
          .enum(['BlockedByClient', 'AccessDenied', 'TimedOut', 'Failed', 'NameNotResolved'])
          .optional(),
      })
      .optional(),
    fulfill: z
      .object({
        status: z.number().int().min(100).max(599).optional(),
        headers: z.record(z.string(), z.string()).optional(),
        body: z.string().optional(),
        bodyBase64: z.string().optional(),
      })
      .optional(),
    modify: z
      .object({
        requestHeaders: z.record(z.string(), z.string()).optional(),
        url: z.string().url().optional(),
        method: z.string().optional(),
      })
      .optional(),
    modifyResponse: z
      .object({
        responseStatus: z.number().int().min(100).max(599).optional(),
        responseHeaders: z.record(z.string(), z.string()).optional(),
        bodyReplace: z.string().optional(),
        bodyRegex: z
          .object({
            pattern: z.string().min(1),
            replacement: z.string(),
            flags: z.string().optional(),
          })
          .optional(),
      })
      .optional(),
  });

// Refined version — used at parse time in handlers. Same superRefine that
// was previously inline; logic unchanged.
const InterceptRuleRefined = InterceptRuleObject.superRefine((rule, ctx) => {
  const hasPattern = rule.urlPattern !== undefined;
  const hasRegex = rule.urlRegex !== undefined;
  if (hasPattern === hasRegex) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'rule must have exactly one of urlPattern or urlRegex',
    });
  }
  const subKeys = ['block', 'fulfill', 'modify', 'modifyResponse'] as const;
  for (const k of subKeys) {
    if (k !== rule.action && rule[k] !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `rule.action='${rule.action}' but sub-object '${k}' was provided`,
      });
    }
  }
  if (rule.fulfill?.body !== undefined && rule.fulfill?.bodyBase64 !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'fulfill.body and fulfill.bodyBase64 are mutually exclusive',
    });
  }
  if (
    rule.modifyResponse?.bodyReplace !== undefined &&
    rule.modifyResponse?.bodyRegex !== undefined
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'modifyResponse.bodyReplace and modifyResponse.bodyRegex are mutually exclusive',
    });
  }
});

// Build the outer shape from a parameterized rule type so Raw and Input
// share one place to add new fields. Earlier versions hand-wrote the
// UrlOrTabIdRaw.extend({rules:...}) twice — easy to miss one when adding
// a sibling field.
function interceptStartShape<R extends z.ZodTypeAny>(rule: R) {
  return urlOrTabIdInputNoFrame({ rules: z.array(rule).min(1) });
}
// Raw: array element is the plain ZodObject (MCP-friendly).
export const InterceptStartInputRaw = interceptStartShape(InterceptRuleObject);
// Input: rule element is refined so parse exercises rule-level superRefine.
export const InterceptStartInput = requireUrlOrTabId(interceptStartShape(InterceptRuleRefined));
export const InterceptStartOutput = z.object({
  interceptId: z.string(),
  tabId: z.number().int(),
  url: z.string(),
});

// ---------- 31. browser_intercept_stop ----------
export const InterceptStopInputRaw = z.object({
  interceptId: z.string().min(1),
});
// No XOR constraint here — Raw and Input are identical. The alias preserves
// the codebase-wide pattern of always exporting both names.
export const InterceptStopInput = InterceptStopInputRaw;
export const InterceptStopOutput = z.object({
  interceptId: z.string(),
  tabId: z.number().int(),
  totalRequests: z.number().int(),
  hitsByRule: z.array(
    z.object({
      ruleIndex: z.number().int(),
      count: z.number().int(),
      sampleUrls: z.array(z.string()),
    }),
  ),
  durationMs: z.number(),
  endedReason: z.enum(['user_stop', 'tab_closed', 'wake_recovery']),
});

// ---------- 32. browser_drag ----------
// from / to: each accepts a CSS selector string OR a {x, y} page coordinate
// object. Schema uses union; handler resolves the variant at runtime.
const DragPointSchema = z.union([
  z.string().min(1),
  z.object({ x: z.number(), y: z.number() }),
]);
export const DragInputRaw = urlOrTabIdInput({
  from: DragPointSchema,
  to: DragPointSchema,
  button: z.enum(['left', 'right', 'middle']).default('left'),
  durationMs: z.number().int().min(50).max(30000).default(500),
  steps: z.number().int().min(2).max(200).default(30),
});
export const DragInput = requireUrlOrTabId(DragInputRaw);
export const DragOutput = z.object({
  tabId: z.number().int(),
  url: z.string(),
  from: z.object({ x: z.number(), y: z.number() }),
  to: z.object({ x: z.number(), y: z.number() }),
  steps: z.number().int(),
  durationMs: z.number(),
});

// ---------- 33. browser_emulate_device ----------
// preset XOR custom; at least one must be present.
// `desktop` resets all overrides; `desktop-*` apply explicit desktop viewports
// (mobile=false, touch=off) so callers don't need to spell out custom every
// time they want a non-mobile size.
const EmulatePresetEnum = z.enum([
  'iphone-17-pro-max',
  'iphone-17',
  'ipad-pro',
  'pixel-9-pro',
  'galaxy-s25-ultra',
  'desktop',
  'desktop-1366',
  'desktop-1440',
  'desktop-1080p',
  'desktop-4k',
]);
const EmulateCustomSchema = z.object({
  width: z.number().int().min(1).max(10000),
  height: z.number().int().min(1).max(10000),
  deviceScaleFactor: z.number().min(0.1).max(10),
  mobile: z.boolean(),
  userAgent: z.string().optional(),
});
export const EmulateDeviceInputRaw = urlOrTabIdInputNoFrame({
  preset: EmulatePresetEnum.optional(),
  custom: EmulateCustomSchema.optional(),
});
// Double-wrapped ZodEffects (requireUrlOrTabId + this superRefine).
// Fine for .parse(); has no .shape (already true after requireUrlOrTabId).
export const EmulateDeviceInput = requireUrlOrTabId(EmulateDeviceInputRaw).superRefine((v, ctx) => {
  const hasPreset = v.preset !== undefined;
  const hasCustom = v.custom !== undefined;
  if (hasPreset === hasCustom) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'exactly one of preset or custom is required',
    });
  }
});
export const EmulateDeviceOutput = z.object({
  tabId: z.number().int(),
  url: z.string(),
  applied: z
    .object({
      width: z.number().int(),
      height: z.number().int(),
      deviceScaleFactor: z.number(),
      mobile: z.boolean(),
      userAgent: z.string(),
    })
    .nullable(),
});
