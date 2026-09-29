import { z } from 'zod';

/**
 * Schemas for the handlers that kept their v0.4 argument shapes (network
 * recording/interception, device emulation, performance, image download).
 * The agent-facing v0.5 tool inputs live in tools.ts; these are only reached
 * through those tools' adapters.
 */

// ---------- Common: framePath mixin ----------
// Optional cross-frame addressing for tools that operate inside a specific
// iframe / nested frame. Each entry is a CSS selector matched against the
// current frame's document; the matched element must be an <iframe> or
// <frame>. An empty array (or omitted field) targets the main frame and
// preserves v0.1 behavior. See spec `2026-04-25-iframe-support-design.md`.
export const FramePathInput = z.object({
  framePath: z.array(z.string().min(1)).max(8).default([]),
});

// ---------- 11. browser_download_images ----------
export const DownloadImagesInput = z.object({
  url: z.string().url().optional(),
  tabId: z.number().int().optional(),
  saveDir: z.string().optional(),               // default: ~/.byob/downloads/<timestamp>/
  reuseTab: z.boolean().default(false),
  screens: z.number().int().min(0).max(50).default(5),     // scroll N screens to trigger lazy loaders
  timeoutSec: z.number().int().min(1).max(600).default(120),
  maxImages: z.number().int().min(1).max(500).default(50),
  minWidth: z.number().int().min(0).default(100),          // skip tiny icons by default
  minHeight: z.number().int().min(0).default(100),
  includeOgImage: z.boolean().default(true),    // also grab og:image / twitter:image meta
}).merge(FramePathInput);
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
export const StopRecordNetworkInput = z.object({
  recordingId: z.string(),
  flushDelayMs: z.number().int().min(0).max(30_000).default(500),
  format: z.enum(['json', 'har']).default('json'),
});

// ---------- 28. browser_get_performance ----------
// CWV indicators may be null when the page lacks the entry (no FCP yet, no
// user interaction so INP=null, no CLS layout shifts so CLS=null). The
// navigation entry is null only on chrome:// internal pages.
export const GetPerformanceInputRaw = urlOrTabIdInputNoFrame({
  waitMs: z.number().int().min(0).max(30_000).default(3000),
});
export const GetPerformanceInput = requireUrlOrTabId(GetPerformanceInputRaw);

// ---------- 30. browser_intercept_start ----------
// Stateful interception: each rule has a matcher (urlPattern XOR urlRegex,
// optional methods filter) and exactly one action (block / fulfill / modify
// / modifyResponse / passthrough). Action-specific args go in the matching
// optional sub-object.

const HttpMethod = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

// Length caps protect the SW main thread from ReDoS — a `(a+)+$` pattern
// grafted onto a high-traffic URL could otherwise pin Chrome's extension
// process. `bodyRegex` runs over multi-MB response bodies so it gets a
// tighter cap than `urlRegex` which only sees URLs.
const URL_PATTERN_MAX = 1024;
const URL_REGEX_MAX = 512;
const BODY_REGEX_MAX = 256;
const REGEX_REPLACEMENT_MAX = 64 * 1024;
const REGEX_FLAGS_MAX = 8;

// Naive "obviously catastrophic" detector: a quantifier (+ * {n,}) that
// directly contains another quantifier in its captured group, e.g. `(a+)+`
// or `(.*)*`. Doesn't catch every ReDoS pattern (a full proof is undecidable
// in general) but rejects the most common AI-generated footguns.
const NESTED_QUANTIFIER_RE = /\([^)]*[+*][^)]*\)[+*?{]/;

// Plain ZodObject — used for MCP inputSchema descriptions (needs .shape).
export const InterceptRuleObject = z
  .object({
    urlPattern: z.string().max(URL_PATTERN_MAX).optional(),
    urlRegex: z.string().max(URL_REGEX_MAX).optional(),
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
            pattern: z.string().min(1).max(BODY_REGEX_MAX),
            replacement: z.string().max(REGEX_REPLACEMENT_MAX),
            flags: z.string().max(REGEX_FLAGS_MAX).optional(),
          })
          .optional(),
      })
      .optional(),
  });

// Refined version — used at parse time in handlers. Same superRefine that
// was previously inline; logic unchanged.
export const InterceptRuleRefined = InterceptRuleObject.superRefine((rule, ctx) => {
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
  // ReDoS guard — reject the obvious nested-quantifier shapes. We don't
  // try to be exhaustive (real ReDoS analysis is undecidable); we reject
  // the AI-generated copy-paste footguns (`(a+)+`, `(.*)*$`, etc.).
  if (rule.urlRegex && NESTED_QUANTIFIER_RE.test(rule.urlRegex)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['urlRegex'],
      message: 'urlRegex contains a nested quantifier likely to cause ReDoS',
    });
  }
  if (rule.modifyResponse?.bodyRegex?.pattern && NESTED_QUANTIFIER_RE.test(rule.modifyResponse.bodyRegex.pattern)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['modifyResponse', 'bodyRegex', 'pattern'],
      message: 'bodyRegex.pattern contains a nested quantifier likely to cause ReDoS',
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
export const InterceptStopInputRaw = z.object({
  interceptId: z.string().min(1),
});
// No XOR constraint here — Raw and Input are identical. The alias preserves
// the codebase-wide pattern of always exporting both names.
export const InterceptStopInput = InterceptStopInputRaw;

// ---------- 33. browser_emulate_device ----------
// preset XOR custom; at least one must be present.
// `desktop` resets all overrides; `desktop-*` apply explicit desktop viewports
// (mobile=false, touch=off) so callers don't need to spell out custom every
// time they want a non-mobile size.
export const EmulatePresetEnum = z.enum([
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
export const EmulateCustomSchema = z.object({
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
