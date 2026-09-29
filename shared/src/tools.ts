/**
 * v0.5 tool inputs — one schema per MCP tool.
 *
 * These are plain ZodObjects: their `.shape` becomes the MCP inputSchema, and
 * the extension parses the same object. Cross-field rules (ref XOR selector,
 * x+y pairs, …) are checked by the handlers, which can explain the problem
 * better than a generic refinement message.
 *
 * Descriptions are deliberately terse: every word here is paid for in the
 * agent's context on every turn.
 */
import { z } from 'zod';
import { EmulateCustomSchema, EmulatePresetEnum } from './schemas.js';

// ---------- shared fields ----------
const tabId = z.number().int().optional().describe('Default: working tab.');
const ref = z.string().optional().describe('Ref from snapshot/find, e.g. "e12".');
const selector = z.string().optional().describe('CSS selector (instead of ref).');
const framePath = z.array(z.string()).max(8).optional().describe('iframe selectors leading to selector.');
const timeoutSec = z.number().min(0).max(120).optional().describe('Auto-wait seconds (default 5).');
const snapshot = z.boolean().optional().describe('Also return a snapshot diff.');
const x = z.number().optional();
const y = z.number().optional();

export const TargetFields = { ref, selector, framePath };

// ---------- navigation & tabs ----------
export const TabsInput = z.object({
  action: z.enum(['list', 'new', 'select', 'close', 'history']).default('list'),
  tabId,
  url: z.string().optional().describe('new: URL.'),
  focus: z.boolean().optional().describe('Also show it to the user.'),
  query: z.string().optional().describe('history: search text.'),
  limit: z.number().int().min(1).max(200).optional(),
});

export const NavigateInput = z.object({
  url: z.string().optional(),
  action: z.enum(['goto', 'back', 'forward', 'reload']).default('goto'),
  tabId,
  newTab: z.boolean().optional(),
  waitUntil: z.enum(['load', 'networkidle', 'none']).default('load'),
  timeoutSec: z.number().min(1).max(300).default(30),
  snapshot,
});

// ---------- observation ----------
export const SnapshotInput = z.object({
  tabId,
  ...TargetFields,
  interactive: z.boolean().optional()
    .describe('Controls only (+ headings, landmarks).'),
  diff: z.boolean().optional().describe('Only changes since the last snapshot.'),
  maxDepth: z.number().int().min(1).max(50).optional(),
  maxChars: z.number().int().min(1000).max(400_000).optional().describe('Default 24000.'),
});

export const FindInput = z.object({
  tabId,
  role: z.string().optional().describe('e.g. button, link, textbox, checkbox, heading.'),
  name: z.string().optional().describe('Accessible name (with role).'),
  text: z.string().optional(),
  label: z.string().optional(),
  placeholder: z.string().optional(),
  alt: z.string().optional(),
  title: z.string().optional(),
  testId: z.string().optional(),
  exact: z.boolean().default(false),
  within: z.string().optional().describe('Search inside this ref.'),
  limit: z.number().int().min(1).max(50).default(10),
  action: z.enum(['click', 'hover', 'focus', 'fill', 'check', 'uncheck']).optional().describe('Act on match #nth.'),
  value: z.string().optional().describe('For fill.'),
  nth: z.number().int().min(0).default(0),
  snapshot,
});

export const ReadInput = z.object({
  url: z.string().optional().describe('Open this URL first.'),
  tabId,
  ...TargetFields,
  format: z.enum(['text', 'markdown', 'html', 'links', 'tables']).default('text'),
  outline: z.boolean().optional().describe('Headings only.'),
  filter: z.string().optional().describe('Only sections mentioning this.'),
  scroll: z.boolean().optional().describe('Scroll first to load lazy content.'),
  maxChars: z.number().int().min(500).max(1_000_000).optional().describe('Default 20000.'),
});

export const ScreenshotInput = z.object({
  tabId,
  url: z.string().optional(),
  ...TargetFields,
  fullPage: z.boolean().optional(),
  format: z.enum(['png', 'jpeg', 'pdf']).default('png'),
  quality: z.number().int().min(1).max(100).optional(),
  annotate: z.boolean().optional().describe('Draw snapshot refs on the image.'),
  ifChanged: z.boolean().optional().describe('Skip if identical to the last shot.'),
  clip: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional(),
  savePath: z.string().optional().describe('Absolute path.'),
  inline: z.boolean().optional().describe('Return the image (default: unless fullPage).'),
  pdf: z.object({ landscape: z.boolean(), pageRanges: z.string(), paperFormat: z.enum(['A4', 'Letter', 'Legal']) })
    .partial().optional(),
});

export const ConsoleInput = z.object({
  tabId,
  level: z.enum(['debug', 'log', 'info', 'warn', 'error']).optional().describe('Minimum level.'),
  since: z.number().int().optional().describe('Only entries after this seq.'),
  limit: z.number().int().min(1).max(1000).default(100),
  clear: z.boolean().optional(),
});

export const InspectInput = z.object({
  tabId,
  action: z.enum(['element', 'performance']).default('element'),
  ...TargetFields,
  styles: z.array(z.string()).max(40).optional().describe('Computed CSS properties.'),
});

// ---------- interaction ----------
export const ClickInput = z.object({
  tabId,
  ...TargetFields,
  x,
  y,
  button: z.enum(['left', 'right', 'middle']).default('left'),
  doubleClick: z.boolean().optional(),
  modifiers: z.array(z.enum(['Alt', 'Control', 'Meta', 'Shift'])).optional(),
  force: z.boolean().optional().describe('Skip actionability checks.'),
  timeoutSec,
  snapshot,
});

export const HoverInput = z.object({ tabId, ...TargetFields, x, y, timeoutSec, snapshot });

export const TypeInput = z.object({
  tabId,
  ...TargetFields,
  text: z.string(),
  clear: z.boolean().default(true).describe('false = append.'),
  slowly: z.boolean().optional().describe('Per-key events.'),
  submit: z.boolean().optional().describe('Press Enter after.'),
  timeoutSec,
  snapshot,
});

export const PressKeyInput = z.object({
  tabId,
  key: z.string().describe('"Enter", "Escape", "ArrowDown", "Shift+Tab", "ControlOrMeta+A"…'),
  ...TargetFields,
  repeat: z.number().int().min(1).max(50).default(1),
  snapshot,
});

export const SelectInput = z.object({
  tabId,
  ...TargetFields,
  values: z.array(z.string()).min(1).describe('Values or labels.'),
  timeoutSec,
  snapshot,
});

export const ScrollInput = z.object({
  tabId,
  ...TargetFields,
  direction: z.enum(['up', 'down', 'left', 'right']).optional(),
  amount: z.number().positive().optional().describe('Pixels (default ~1 screen).'),
  to: z.enum(['top', 'bottom']).optional(),
});

const DragEnd = z.object({ ref: z.string().optional(), selector: z.string().optional(), x, y });
export const DragInput = z.object({
  tabId,
  from: DragEnd,
  to: DragEnd,
  framePath,
  steps: z.number().int().min(2).max(200).default(20),
  snapshot,
});

export const UploadFileInput = z.object({
  tabId,
  ...TargetFields,
  paths: z.array(z.string()).min(1).describe('Absolute paths.'),
});

export const WaitInput = z.object({
  tabId,
  ...TargetFields,
  state: z.enum(['visible', 'hidden', 'attached', 'detached']).optional().describe('Default visible.'),
  text: z.string().optional().describe('Text to appear.'),
  textGone: z.string().optional().describe('Text to disappear.'),
  url: z.string().optional().describe('Substring or * glob.'),
  load: z.enum(['load', 'networkidle']).optional(),
  fn: z.string().optional().describe('JS predicate.'),
  ms: z.number().int().min(0).max(120_000).optional().describe('Delay.'),
  timeoutSec: z.number().min(0).max(300).default(30),
});

export const EvaluateInput = z.object({
  tabId,
  expression: z.string().describe('Expression, or body with return. `el` = target.'),
  ...TargetFields,
  awaitPromise: z.boolean().default(true),
});

// ---------- state & environment ----------
export const StorageInput = z.object({
  kind: z.enum(['cookies', 'local', 'session']).default('cookies'),
  action: z.enum(['get', 'set', 'clear']).default('get'),
  tabId,
  url: z.string().optional().describe('cookies: default the tab URL.'),
  domain: z.string().optional(),
  name: z.string().optional().describe('One cookie / key.'),
  cookies: z.array(z.record(z.string(), z.unknown())).optional()
    .describe('set: [{name, value, url?, domain?, path?, secure?, httpOnly?, sameSite?, expirationDate?}]'),
  items: z.record(z.string(), z.string()).optional().describe('local/session set: {key: value}.'),
  framePath,
});

export const DialogInput = z.object({
  tabId,
  action: z.enum(['get', 'accept', 'dismiss']).default('get'),
  promptText: z.string().optional(),
});

export const ClipboardInput = z.object({
  action: z.enum(['read', 'write']),
  text: z.string().optional(),
});

export const EmulateInput = z.object({
  tabId,
  device: EmulatePresetEnum.optional(),
  viewport: EmulateCustomSchema.optional(),
  colorScheme: z.enum(['light', 'dark', 'no-preference']).optional(),
  reducedMotion: z.boolean().optional(),
  geolocation: z.object({ latitude: z.number(), longitude: z.number(), accuracy: z.number().optional() }).optional(),
  offline: z.boolean().optional(),
  timezone: z.string().optional().describe('e.g. "Asia/Tokyo".'),
  locale: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional().describe('Extra request headers.'),
  reset: z.boolean().optional(),
});

export const NetworkInput = z.object({
  action: z.enum(['record', 'stop', 'intercept', 'unintercept']),
  tabId,
  id: z.string().optional().describe('From record/intercept.'),
  urlPattern: z.string().optional(),
  resourceTypes: z.array(z.string()).optional().describe('Default ["xhr","fetch"]; ["*"] = all.'),
  includeBodies: z.boolean().default(true),
  maxRecords: z.number().int().min(1).max(10_000).optional(),
  format: z.enum(['summary', 'json', 'har']).default('summary').describe('stop: json/har go to a file.'),
  // The full rule schema (validated by the extension) is ~1.5k characters
  // of JSON Schema; the model only needs its shape.
  rules: z.array(z.record(z.string(), z.unknown())).optional().describe(
    'intercept: [{urlPattern (glob) | urlRegex, methods?, action: "block"|"fulfill"|"modify"|"modifyResponse", ' +
    'fulfill?: {status, headers, body}, modify?: {requestHeaders, url, method}, ' +
    'modifyResponse?: {responseStatus, responseHeaders, bodyReplace | bodyRegex: {pattern, replacement}}}]'),
});

export const DownloadImagesInput = z.object({
  tabId,
  url: z.string().optional(),
  saveDir: z.string().optional(),
  minWidth: z.number().int().min(0).optional(),
  minHeight: z.number().int().min(0).optional(),
  maxImages: z.number().int().min(1).max(1000).optional(),
});

export const BatchStep = z.object({
  tool: z.string().describe('e.g. "click", "type".'),
  args: z.record(z.string(), z.unknown()).default({}),
});
export const BatchInput = z.object({
  steps: z.array(BatchStep).min(1).max(50),
  stopOnError: z.boolean().default(true),
  snapshot,
});

export type TargetSpecInput = { ref?: string; selector?: string; framePath?: string[] };

export type ScreenshotInputT = z.infer<typeof ScreenshotInput>;
export type EmulateInputT = z.infer<typeof EmulateInput>;

/** Validated by the extension for storage set (the MCP schema only
 *  describes the shape, to keep the tool definition small). */
export const CookieSetItem = z.object({
  name: z.string(),
  value: z.string(),
  url: z.string().optional(),
  domain: z.string().optional(),
  path: z.string().optional(),
  secure: z.boolean().optional(),
  httpOnly: z.boolean().optional(),
  sameSite: z.enum(['no_restriction', 'lax', 'strict']).optional(),
  expirationDate: z.number().optional(),
});
