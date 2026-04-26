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
}).merge(FramePathInput);
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
}).merge(FramePathInput);
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
}).merge(FramePathInput);
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
// `to`/`selector`/`y` 三选一（XOR）；用 superRefine 来表达。
export const ScrollInputRaw = UrlOrTabIdRaw.extend({
  to: z.enum(['top', 'bottom']).optional(),
  selector: z.string().optional(),
  y: z.number().optional(),
  behavior: z.enum(['auto', 'smooth']).default('auto'),
}).merge(FramePathInput);
export const ScrollInput = requireUrlOrTabId(ScrollInputRaw).superRefine((v, ctx) => {
  const provided = [v.to, v.selector, v.y].filter((x) => x !== undefined).length;
  if (provided !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'exactly one of {to, selector, y} is required',
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
export const PressKeyInputRaw = UrlOrTabIdRaw.extend({
  key: z.string().min(1),
  modifiers: z.array(z.enum(['Alt', 'Control', 'Shift', 'Meta'])).default([]),
}).merge(FramePathInput);
export const PressKeyInput = requireUrlOrTabId(PressKeyInputRaw);
export const PressKeyOutput = z.object({
  tabId: z.number().int(),
  url: z.string(),
});

// ---------- 19. browser_select ----------
// `value`/`label`/`index` 三选一（XOR）。
export const SelectInputRaw = UrlOrTabIdRaw.extend({
  selector: z.string().min(1),
  value: z.string().optional(),
  label: z.string().optional(),
  index: z.number().int().min(0).optional(),
}).merge(FramePathInput);
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
export const HoverInputRaw = UrlOrTabIdRaw.extend({
  selector: z.string().min(1),
}).merge(FramePathInput);
export const HoverInput = requireUrlOrTabId(HoverInputRaw);
export const HoverOutput = z.object({
  tabId: z.number().int(),
  url: z.string(),
});

// ---------- 24. browser_get_html ----------
export const GetHtmlInputRaw = UrlOrTabIdRaw.extend({
  selector: z.string().default('html'),
  outerHtml: z.boolean().default(true),
  maxBytes: z.number().int().min(1).max(8 * 1024 * 1024).default(262144),
}).merge(FramePathInput);
export const GetHtmlInput = requireUrlOrTabId(GetHtmlInputRaw);
export const GetHtmlOutput = z.object({
  tabId: z.number().int(),
  url: z.string(),
  html: z.string(),
  byteLength: z.number().int(),
  truncated: z.boolean(),
});
