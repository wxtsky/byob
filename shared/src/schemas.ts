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
});
export const EvalOutput = z.object({
  result: z.unknown(),
  // NB: name is `resultType` not `type` to avoid colliding with the
  // NM-protocol top-level `type:"result"` envelope field.
  resultType: z.string(),
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
});
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
