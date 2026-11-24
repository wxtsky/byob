import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Routes, Tools } from '@byob/shared';
import {
  renderAction,
  renderConsole,
  renderEvaluate,
  renderFind,
  renderGeneric,
  renderNavigate,
  renderNetwork,
  renderRead,
  renderRecord,
  renderScreenshot,
  renderSnapshot,
  renderStorage,
  renderTabs,
  renderWait,
  fmtSize,
} from '../format.js';
import { checkSavePath } from '../files.js';
import { clean } from '../json-output.js';
import { outputMode, type OutputMode } from '../mode.js';
import { getWorkingTab } from '../state.js';
import { register, type ToolSpec } from './_factory.js';
import { batchSpec } from './batch.js';
import { enableToolsSpec, toolProfile, type ToolProfile } from './profile.js';

/** Page JavaScript is on unless the user opts out with BYOB_ALLOW_EVAL=0. */
const evalAllowed = (): boolean => process.env.BYOB_ALLOW_EVAL !== '0';

/** Same rule as the extension's navigate/read: no scheme means https. */
const withScheme = (url: string): string => (/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`);

const invalid = (message: string): Error => Object.assign(new Error(message), { code: 'invalid_argument' });

/** Auto-wait (timeoutSec, default 5) plus room for the action itself. */
const actionTimeout = (a: Record<string, any>): number => (a.timeoutSec ?? 5) + 30;

const ACT = 'Auto-waits until actionable (visible, enabled, not covered); reports navigation, new tabs and dialogs it caused.';

export const specs: ToolSpec[] = [
  {
    name: 'browser_tabs',
    title: 'List, open, select or close tabs',
    description:
      "Tabs of the user's real Chrome: list · new (background, in the \"byob\" group) · select (make it the working tab — where calls go without tabId) · close · history (search).",
    input: Tools.TabsInput,
    command: 'tabs',
    tab: 'none',
    readOnly: false,
    render: (r, a) => renderTabs(r, a, getWorkingTab()),
  },
  {
    name: 'browser_navigate',
    title: 'Open a URL / back / forward / reload',
    description:
      "Open a URL (a new background tab, then reused — never the user's own tab) or back/forward/reload. Waits for load; waitUntil:\"networkidle\" for SPAs.",
    input: Tools.NavigateInput,
    opensUrl: true,
    command: 'navigate',
    tab: 'navigate',
    // networkidle waits for load, then up to timeoutSec again for quiet.
    timeoutSec: (a) => (a.timeoutSec ?? 30) * (a.waitUntil === 'networkidle' ? 2 : 1) + 15,
    render: renderNavigate,
  },
  {
    name: 'browser_snapshot',
    title: 'Accessibility snapshot with element refs',
    description:
      'The page as an outline of roles and names (iframes included) — the main way to see a page. Interactive elements get refs like [ref=e12] for click/type/etc., valid until the page navigates. Scope with ref/selector.',
    input: Tools.SnapshotInput,
    command: 'snapshot',
    readOnly: true,
    maxOutput: 400_000,
    render: renderSnapshot,
  },
  {
    name: 'browser_find',
    title: 'Find elements by role, text or label',
    description:
      'Locate elements semantically and get refs: role(+name), text, label, placeholder, alt, title or testId (substring, case-insensitive unless exact). With action (click/fill/check/…) acts on match #nth right away — no snapshot needed.',
    input: Tools.FindInput,
    command: 'find',
    render: renderFind,
  },
  {
    name: 'browser_click',
    title: 'Click an element',
    description: `Click by ref (from snapshot/find), CSS selector, or viewport x+y. Real mouse events. ${ACT}`,
    input: Tools.ClickInput,
    command: 'click',
    timeoutSec: actionTimeout,
    compactInBatch: true,
    render: renderAction,
  },
  {
    name: 'browser_type',
    title: 'Type into a field',
    description: `Fill an input / textarea / contenteditable (replaces content; clear:false appends). No target = the focused element. slowly:true types key by key (autocompletes), submit:true presses Enter. ${ACT}`,
    input: Tools.TypeInput,
    command: 'type',
    timeoutSec: actionTimeout,
    compactInBatch: true,
    render: renderAction,
  },
  {
    name: 'browser_press_key',
    title: 'Press a key or shortcut',
    description: 'Press a key or combo on the focused element (or on a ref/selector, focused first): Enter, Escape, Tab, ArrowDown, Backspace, "Shift+Tab", "ControlOrMeta+A" (Cmd on macOS). Reports navigation/dialogs caused.',
    input: Tools.PressKeyInput,
    command: 'pressKey',
    compactInBatch: true,
    render: renderAction,
  },
  {
    name: 'browser_hover',
    title: 'Hover an element',
    description: 'Move the mouse over a ref / selector / x+y (menus, tooltips). snapshot:true shows what appeared.',
    input: Tools.HoverInput,
    command: 'hover',
    timeoutSec: actionTimeout,
    compactInBatch: true,
    render: renderAction,
  },
  {
    name: 'browser_select',
    title: 'Choose options in a <select>',
    description: 'Select option(s) of a native <select> by value or visible label. For custom dropdowns click the control, then the option.',
    input: Tools.SelectInput,
    command: 'select',
    timeoutSec: actionTimeout,
    compactInBatch: true,
    render: renderAction,
  },
  {
    name: 'browser_scroll',
    title: 'Scroll the page or an element',
    description: 'Scroll the page, or the container given by ref/selector, by direction (+amount px) or to top/bottom. A target without direction scrolls it into view. Reports the position, so you know when the end is reached.',
    input: Tools.ScrollInput,
    command: 'scroll',
    compactInBatch: true,
    render: renderAction,
  },
  {
    name: 'browser_drag',
    title: 'Drag and drop',
    description: 'Drag from one ref/selector/x+y to another. Supports HTML5 drag-and-drop as well as mouse-driven sliders and sortable lists.',
    input: Tools.DragInput,
    command: 'drag',
    tab: 'working',
    compactInBatch: true,
    render: renderAction,
  },
  {
    name: 'browser_upload_file',
    title: 'Attach local files to a file input',
    description: 'Attach absolute local file paths to an <input type=file> (hidden ones too: selector "input[type=file]"), or to a button that opens a file picker.',
    input: Tools.UploadFileInput,
    command: 'uploadFile',
    prepare: (a) => {
      for (const p of a.paths as string[]) {
        if (!path.isAbsolute(p)) throw Object.assign(new Error(`path is not absolute: ${p}`), { code: 'file_not_found' });
        if (!fs.existsSync(p) || !fs.statSync(p).isFile()) throw Object.assign(new Error(`file not found: ${p}`), { code: 'file_not_found' });
      }
      return a;
    },
    compactInBatch: true,
    render: renderAction,
  },
  {
    name: 'browser_wait',
    title: 'Wait for a condition',
    description: 'Wait (AND of all given): element state, text appears/gone, URL match, load/networkidle, JS predicate fn, ms delay. Actions already auto-wait — use this for things that happen later.',
    input: Tools.WaitInput,
    command: 'wait',
    readOnly: true,
    timeoutSec: (a) => (a.timeoutSec ?? 30) + (a.ms ?? 0) / 1000 + 10,
    prepare: (a) => {
      if (a.fn !== undefined && !evalAllowed()) {
        throw Object.assign(new Error('wait.fn runs page JavaScript and is disabled.'), {
          code: 'eval_disabled', hint: 'The user turned page JavaScript off (BYOB_ALLOW_EVAL=0); wait on text/selector/url instead.',
        });
      }
      return a;
    },
    render: renderWait,
  },
  {
    name: 'browser_read',
    title: 'Read page content',
    description:
      'Page content (PDFs too): text (all visible), markdown (main article, else whole page), html, links or tables; scope with ref/selector. To click things, use snapshot.',
    input: Tools.ReadInput,
    opensUrl: true,
    command: 'read',
    readOnly: true,
    maxOutput: 1_000_000,
    // urls: four pages at a time, each with up to 30 s to load.
    timeoutSec: (a) => (a.urls?.length ? 60 + 40 * Math.ceil(a.urls.length / 4) : 120),
    render: renderRead,
  },
  {
    name: 'browser_screenshot',
    title: 'Screenshot (or PDF)',
    description:
      'Viewport (default), fullPage, element (ref/selector) or clip; returns the image and saves it. annotate:true labels the snapshot refs on it. format:"pdf" prints to PDF.',
    input: Tools.ScreenshotInput,
    opensUrl: true,
    command: 'screenshot',
    readOnly: true,
    // A script looks with Read({file_path}) when it wants to; a loop of
    // screenshots would otherwise put every image in the model's context.
    scriptDefaults: { inline: false },
    timeoutSec: () => 120,
    prepare: (a) => {
      // Fail before capturing (and moving the diff/ifChanged baseline).
      if (a.savePath !== undefined) checkSavePath(a.savePath, a.format === 'jpeg' ? 'jpg' : (a.format ?? 'png'));
      return a;
    },
    render: renderScreenshot,
  },
  {
    name: 'browser_console',
    title: 'Console messages and page errors',
    description: 'Console output, uncaught errors and browser warnings of a tab, buffered since byob first touched it.',
    input: Tools.ConsoleInput,
    command: 'console',
    readOnly: true,
    render: renderConsole,
  },
  {
    name: 'browser_inspect',
    group: 'inspect',
    title: 'Element details / page performance',
    description: 'element: box, visibility, state, value, attributes, match count, computed styles. performance: Web Vitals + timing.',
    input: Tools.InspectInput,
    command: 'inspect',
    readOnly: true,
    render: renderGeneric,
  },
  {
    name: 'browser_storage',
    title: 'Cookies and local/session storage',
    description: 'get / set / clear cookies (default: the tab URL) or local/sessionStorage — e.g. export a login cookie for curl.',
    input: Tools.StorageInput,
    command: 'storage',
    prepare: (a) => {
      if (a.savePath !== undefined) {
        if ((a.kind ?? 'cookies') !== 'cookies' || (a.action ?? 'get') !== 'get') {
          throw Object.assign(new Error('savePath only applies to getting cookies.'), { code: 'invalid_argument' });
        }
        checkSavePath(a.savePath, 'txt');
      }
      return a;
    },
    render: renderStorage,
  },
  {
    name: 'browser_dialog',
    title: 'Handle alert/confirm/prompt',
    description: 'Get or answer (accept/dismiss + promptText) a JS dialog. Never auto-accepted; actions report when one opens.',
    input: Tools.DialogInput,
    command: 'dialog',
    render: renderGeneric,
  },
  {
    name: 'browser_emulate',
    group: 'emulate',
    title: 'Emulate device, media, location, network',
    description: 'Device/viewport, color scheme, reduced motion, geolocation, timezone, locale, offline, extra headers; reset:true clears all.',
    input: Tools.EmulateInput,
    command: 'emulate',
    render: renderGeneric,
  },
  {
    name: 'browser_network',
    group: 'network',
    title: 'Record or intercept network traffic',
    description: 'record → act → stop (summary, or json/har file). To catch an API reply: record {urlPattern:"*/api/x*"} → click → stop {waitFor:1}. intercept: block / mock / modify requests; unintercept to stop. Cross-site iframes included.',
    input: Tools.NetworkInput,
    command: 'network',
    timeoutSec: (a) => (a.action === 'stop' ? 300 + (a.waitFor ? (a.timeoutSec ?? 30) : 0) : 60),
    render: renderNetwork,
  },
  {
    name: 'browser_clipboard',
    group: 'clipboard',
    title: 'Read or write the clipboard',
    description: 'Read or write plain text on the system clipboard (explicit calls only).',
    input: Tools.ClipboardInput,
    command: 'clipboard',
    tab: 'none',
    render: (r) => ({ text: r.text !== undefined ? `Clipboard: ${r.text}` : `Wrote ${r.written} chars to the clipboard.` }),
  },
  {
    name: 'browser_download_images',
    group: 'download_images',
    title: 'Download images from a page',
    description: 'Save the images of a page (or url) to disk, skipping icons smaller than minWidth×minHeight.',
    input: Tools.DownloadImagesInput,
    opensUrl: true,
    command: 'downloadImages',
    route: Routes.downloadImages,
    timeoutSec: () => 180,
    prepare: (a) => {
      // The bridge writes the files, and its working directory is wherever
      // Chrome started it — so a relative or ~ path must not reach it.
      if (typeof a.saveDir === 'string') {
        const dir = a.saveDir === '~' ? os.homedir() : a.saveDir.replace(/^~(?=[/\\])/, os.homedir());
        if (!path.isAbsolute(dir)) throw invalid(`saveDir must be an absolute path, got: ${a.saveDir}`);
        a = { ...a, saveDir: dir };
      }
      if (typeof a.url === 'string') a = { ...a, url: withScheme(a.url) };
      return a;
    },
    render: (r) => ({
      text: `Saved ${r.images?.length ?? 0} image(s) to ${r.saveDir} (${r.skipped ?? 0} skipped${r.blockedByPolicy ? `, ${r.blockedByPolicy} blocked by site policy` : ''})\n${(r.images ?? []).slice(0, 50).map((i: { path: string; width?: number; height?: number }) => `- ${i.path}${i.width ? ` (${i.width}×${i.height})` : ''}`).join('\n')}`,
    }),
  },
  {
    name: 'browser_downloads',
    group: 'downloads',
    title: 'Files your actions downloaded',
    description:
      "Downloads started by byob's clicks (never the user's own). wait (default): until the newest one — or id — finishes; returns its path, size and type. list: all of them.",
    input: Tools.DownloadsInput,
    command: 'downloads',
    tab: 'none',
    readOnly: true,
    timeoutSec: (a) => (a.timeoutSec ?? 60) + 15,
    render: renderDownloads,
  },
  {
    name: 'browser_record',
    group: 'record',
    title: 'Record a video of a tab',
    description: 'start → act → stop: records the tab (background tabs too) to a .webm video; stop saves it and reports path, duration and size. Up to 10 min / 40 MB.',
    input: Tools.RecordInput,
    command: 'record',
    readOnly: true,
    timeoutSec: (a) => (a.action === 'stop' ? 120 : 30),
    prepare: (a) => {
      // Fail before the recording is collected, not after.
      if (a.savePath !== undefined) checkSavePath(a.savePath, 'webm');
      return a;
    },
    render: renderRecord,
  },
  {
    name: 'browser_fetch',
    title: 'Call a URL with the browser\'s login',
    description:
      'HTTP request with the browser\'s cookies, returning status, headers and body (JSON pretty-printed) — for site APIs and JSON endpoints, no page needed. from:"page" (default) runs inside the tab (its origin, CORS); from:"extension" reaches any site without CORS.',
    input: Tools.FetchInput,
    command: 'fetch',
    timeoutSec: (a) => (a.timeoutSec ?? 30) + 15,
    prepare: (a) => {
      if (a.savePath !== undefined && !path.isAbsolute(a.savePath)) throw invalid(`savePath must be absolute, got: ${a.savePath}`);
      return a;
    },
    render: renderFetch,
  },
  {
    name: 'browser_userscript',
    group: 'userscript',
    title: 'Resident scripts that run on page load',
    description:
      'Register JavaScript that Chrome runs on every matching page as it loads — every tab, across reloads and restarts (like Tampermonkey). add {matches, code, runAt?, world?, id?} · list · remove {id} · clear.',
    input: Tools.UserscriptInput,
    command: 'userscript',
    tab: 'none',
    render: renderUserscript,
  },
  {
    name: 'browser_evaluate',
    title: 'Run JavaScript in the page',
    description: 'Evaluate an expression (or a function body with return) in the page, main world (page globals visible), awaiting promises. With ref/selector the element is available as `el`.',
    input: Tools.EvaluateInput,
    command: 'evaluate',
    enabled: evalAllowed,
    render: renderEvaluate,
  },
];

/**
 * JSON output (Code Mode) only: what a call resolves to, appended to the
 * description. Code Mode loads definitions on demand, so these cost nothing
 * per turn; they spare the script an Object.keys() round trip.
 */
const ACT_RETURNS = '{tabId, summary, effects: {navigated?: {url, title, sameDocument}, newTabs?: [{tabId, url}], dialog?: {type, message}, downloads?: [...]}, snapshot? (with snapshot:true)}.';
const RETURNS: Record<string, string> = {
  browser_tabs: 'list → {tabs: [{tabId, title, url, active, agent, working?}]}; new/select → {tabId, url, title}; close → {tabId, closed}; history → {history: [{url, title, lastVisit}]}.',
  browser_navigate: '{tabId, url, title, opened, stillLoading?, snapshot?}. Opening several URLs at once gives each its own tab.',
  browser_snapshot: '{tabId, url, title, text (the outline with refs), version, truncated, diff?: {base, added, removed, unchanged}}.',
  browser_find: '{tabId, matches: [{ref, role, name}]}; with action also {summary, effects, ref}.',
  browser_click: ACT_RETURNS,
  browser_type: ACT_RETURNS,
  browser_press_key: ACT_RETURNS,
  browser_hover: ACT_RETURNS,
  browser_select: ACT_RETURNS,
  browser_scroll: `${ACT_RETURNS.slice(0, -1)} plus scroll: {top, left, maxTop, maxLeft}.`,
  browser_drag: ACT_RETURNS,
  browser_upload_file: ACT_RETURNS,
  browser_wait: '{tabId, waitedMs, satisfied: [...]}; with user: {user: "done"|"declined"|"pending"|"tab_closed", url, title}.',
  browser_read: '{tabId, url, title, format, text, totalChars, truncated} (format "links": links: [{text, url}]); with urls: {pages: [{url, title, text, error?}]}.',
  browser_screenshot: '{tabId, path, width, height, what, format} — look at it with Read({file_path: path}); inline:true also attaches the image.',
  browser_console: '{entries: [{seq, level, source, text, location}], lastSeq, dropped}.',
  browser_storage: 'cookies → {cookies: [{name, value, domain, path, httpOnly, secure, expires}], header (Cookie header value), cookieJar? (savePath)}; local/session → {origin, items: {key: value}}.',
  browser_dialog: '{tabId, dialog: {type, message, defaultPrompt} | null}.',
  browser_network: 'record/intercept → {id, tabId}; stop → {records: [{url, method, resourceType, responseStatus, responseHeaders, responseBody, timing}], recordCount, waited?, path? (format json/har)}.',
  browser_downloads: 'list → {downloads: [{id, name, state, path, bytes, mime, url}]}; wait → {download: {...}, inProgress?}.',
  browser_download_images: '{saveDir, images: [{path, width, height}], skipped}.',
  browser_record: 'start → {id, tabId}; stop → {path, durationMs, bytes, frames}.',
  browser_fetch: '{status, statusText, url, headers, bytes, truncated} plus json (a JSON body, parsed) | body (other text) | bodyBase64 (binary).',
  browser_userscript: 'list → {scripts: [{id, matches, runAt, world, registered}]}; add → {script, replaced}.',
  browser_evaluate: '{value, valueType}.',
};
for (const s of specs) s.returns ??= RETURNS[s.name];

export interface RegisterOptions {
  profile?: ToolProfile;
  output?: OutputMode;
}

export function registerAllTools(server: McpServer, { profile = toolProfile(), output = outputMode() }: RegisterOptions = {}): void {
  const handles = new Map<string, RegisteredTool>();
  for (const s of specs) {
    const h = register(server, s, output);
    if (!h) continue;
    // Not connected yet, so this sends no list_changed.
    if (s.group && profile === 'core') h.disable();
    handles.set(s.name, h);
  }
  register(server, batchSpec(specs, (s) => handles.get(s.name)?.enabled === true), output);
  if (profile === 'core') register(server, enableToolsSpec(server, specs, handles), output);
}

function renderFetch(r: Record<string, any>, a: Record<string, any>): { text: string; data: Record<string, any> } {
  const head = `${r.status} ${r.statusText ?? ''}`.trim() + ` · ${r.url}${r.redirected ? ' (redirected)' : ''} · ${fmtSize(r.bytes ?? 0)}${r.from === 'extension' ? ' · from extension' : ''}`;
  const keep = ['content-type', 'location', 'set-cookie', 'retry-after', 'x-request-id'];
  const hdrs = Object.entries((r.headers ?? {}) as Record<string, string>).filter(([k]) => keep.includes(k)).map(([k, v]) => `${k}: ${v}`);
  let saved = '';
  if (a.savePath) {
    fs.mkdirSync(path.dirname(a.savePath), { recursive: true });
    fs.writeFileSync(a.savePath, r.encoding === 'base64' ? Buffer.from(r.body, 'base64') : r.body, { mode: 0o600 });
    saved = `\nSaved body → ${a.savePath}${r.truncated ? ' (cut at 50 MB)' : ''}`;
  }
  // Scripts get a JSON body parsed (json), any other text as body, binary as bodyBase64.
  const { body: raw, ...rest } = r;
  const data = clean(rest) as Record<string, any>;
  if (a.savePath) data.savedTo = a.savePath;
  let body: string = raw ?? '';
  if (r.encoding === 'base64') {
    if (!a.savePath) data.bodyBase64 = raw;
    body = `(binary ${r.headers?.['content-type'] ?? ''}, ${fmtSize(r.bytes ?? 0)}${a.savePath ? '' : ' — pass savePath to keep it'})`;
  } else if (/json/i.test(r.headers?.['content-type'] ?? '') || /^\s*[[{]/.test(body)) {
    try {
      data.json = JSON.parse(body);
      body = JSON.stringify(data.json, null, 2);
    } catch {
      data.body = raw; // not JSON after all
    }
  } else {
    data.body = raw;
  }
  const max = a.maxChars ?? 50_000;
  const cut = body.length > max;
  if (cut) body = body.slice(0, max);
  return { text: `${head}\n${hdrs.join('\n')}${saved}\n\n${body}${cut || r.truncated ? `\n… (truncated; ${a.savePath ? 'full body saved' : 'raise maxChars or pass savePath'})` : ''}`, data };
}

function renderUserscript(r: Record<string, any>): { text: string } {
  const line = (s: Record<string, any>) =>
    `- ${s.id}${s.registered === false ? ' (NOT registered — run add again)' : ''}: ${(s.matches ?? []).join(', ')} · ${s.runAt} · ${s.world}${s.allFrames ? ' · all frames' : ''} · ${s.chars} chars\n    ${String(s.preview).replace(/\s+/g, ' ')}`;
  if (r.action === 'list') return { text: r.scripts?.length ? `${r.scripts.length} resident script(s):\n${r.scripts.map(line).join('\n')}` : 'No resident scripts.' };
  if (r.action === 'clear') return { text: `Removed all ${r.removed} resident script(s).` };
  if (r.action === 'remove') return { text: `Removed resident script ${r.id}.` };
  return { text: `${r.replaced ? 'Replaced' : 'Added'} resident script — runs on the next load of matching pages (reload open ones):\n${line(r.script)}` };
}

type Dl = { id: number; name: string; state: string; path?: string; bytes?: number; totalBytes?: number; mime?: string; url: string; error?: string };

function downloadLine(d: Dl): string {
  const size = d.bytes !== undefined ? ` ${fmtSize(d.bytes)}${d.state === 'in_progress' && d.totalBytes ? ` of ${fmtSize(d.totalBytes)}` : ''}` : '';
  const where = d.path ? ` → ${d.path}` : '';
  return `[${d.id}] ${d.name} — ${d.state.replace('_', ' ')}${size}${d.mime ? `, ${d.mime}` : ''}${where}${d.error ? ` (${d.error})` : ''}`;
}

function renderDownloads(r: Record<string, any>): { text: string } {
  if (r.action === 'list') {
    const list = (r.downloads ?? []) as Dl[];
    return { text: list.length ? `${list.length} download(s) started by byob:\n${list.map(downloadLine).join('\n')}` : 'No downloads started by byob yet.' };
  }
  const d = r.download as Dl;
  if (r.inProgress) return { text: `Still downloading: ${downloadLine(d)}\nCall wait again with id ${d.id}.` };
  return { text: `Downloaded ${d.name}${d.bytes !== undefined ? ` (${fmtSize(d.bytes)}${d.mime ? `, ${d.mime}` : ''})` : ''} → ${d.path}\nFrom ${d.url}` };
}
