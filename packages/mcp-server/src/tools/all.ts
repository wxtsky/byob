import * as fs from 'node:fs';
import * as path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
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
  renderScreenshot,
  renderSnapshot,
  renderStorage,
  renderTabs,
  renderWait,
} from '../format.js';
import { getWorkingTab } from '../state.js';
import { register, type ToolSpec } from './_factory.js';
import { batchSpec } from './batch.js';

const evalAllowed = (): boolean => process.env.BYOB_ALLOW_EVAL === '1';

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
    timeoutSec: (a) => (a.timeoutSec ?? 30) + 15,
    render: renderNavigate,
  },
  {
    name: 'browser_snapshot',
    title: 'Accessibility snapshot with element refs',
    description:
      'The page as an outline of roles and names (iframes included) — the main way to see a page. Interactive elements get refs like [ref=e12] for click/type/etc., valid until the page navigates. interactive:true = controls only; diff:true = only changes since the last snapshot; scope with ref/selector.',
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
    timeoutSec: (a) => (a.timeoutSec ?? 5) + 30,
    render: renderAction,
  },
  {
    name: 'browser_type',
    title: 'Type into a field',
    description: `Fill an input / textarea / contenteditable (replaces content; clear:false appends). No target = the focused element. slowly:true for autocompletes, submit:true presses Enter. ${ACT}`,
    input: Tools.TypeInput,
    command: 'type',
    timeoutSec: (a) => (a.timeoutSec ?? 5) + 30,
    render: renderAction,
  },
  {
    name: 'browser_press_key',
    title: 'Press a key or shortcut',
    description: 'Press a key or combo on the focused element (or on a ref/selector, focused first): Enter, Escape, Tab, ArrowDown, Backspace, "Shift+Tab", "ControlOrMeta+A" (Cmd on macOS). Reports navigation/dialogs caused.',
    input: Tools.PressKeyInput,
    command: 'pressKey',
    render: renderAction,
  },
  {
    name: 'browser_hover',
    title: 'Hover an element',
    description: 'Move the mouse over a ref / selector / x+y (menus, tooltips). snapshot:true shows what appeared.',
    input: Tools.HoverInput,
    command: 'hover',
    render: renderAction,
  },
  {
    name: 'browser_select',
    title: 'Choose options in a <select>',
    description: 'Select option(s) of a native <select> by value or visible label. For custom dropdowns click the control, then the option.',
    input: Tools.SelectInput,
    command: 'select',
    render: renderAction,
  },
  {
    name: 'browser_scroll',
    title: 'Scroll the page or an element',
    description: 'direction up/down/left/right (optional amount px) or to top/bottom — for the page, or inside the scroll container given by ref/selector. A target without direction scrolls it into view. Reports the scroll position so you know when the end is reached.',
    input: Tools.ScrollInput,
    command: 'scroll',
    render: renderAction,
  },
  {
    name: 'browser_drag',
    title: 'Drag and drop',
    description: 'Drag from one ref/selector/x+y to another. Supports HTML5 drag-and-drop as well as mouse-driven sliders and sortable lists.',
    input: Tools.DragInput,
    command: 'drag',
    tab: 'working',
    render: renderAction,
  },
  {
    name: 'browser_upload_file',
    title: 'Attach local files to a file input',
    description: 'Set absolute local file paths on an <input type=file> (hidden inputs work: target them with selector "input[type=file]").',
    input: Tools.UploadFileInput,
    command: 'uploadFile',
    prepare: (a) => {
      for (const p of a.paths as string[]) {
        if (!path.isAbsolute(p)) throw Object.assign(new Error(`path is not absolute: ${p}`), { code: 'file_not_found' });
        if (!fs.existsSync(p) || !fs.statSync(p).isFile()) throw Object.assign(new Error(`file not found: ${p}`), { code: 'file_not_found' });
      }
      return a;
    },
    render: renderAction,
  },
  {
    name: 'browser_wait',
    title: 'Wait for a condition',
    description: 'Wait (AND of all given): element state, text appears/gone, URL match, load/networkidle, JS predicate fn (BYOB_ALLOW_EVAL=1), ms delay. Actions already auto-wait — use this for things that happen later.',
    input: Tools.WaitInput,
    command: 'wait',
    readOnly: true,
    timeoutSec: (a) => (a.timeoutSec ?? 30) + (a.ms ?? 0) / 1000 + 10,
    prepare: (a) => {
      if (a.fn !== undefined && !evalAllowed()) {
        throw Object.assign(new Error('wait.fn runs page JavaScript and is disabled.'), {
          code: 'eval_disabled', hint: 'Set BYOB_ALLOW_EVAL=1 in the MCP server env, or wait on text/selector/url instead.',
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
      'Page content: text (all visible), markdown (main article, else whole page), html, links or tables. outline:true = headings only; filter = sections mentioning a phrase; scope with ref/selector. For finding things to click use snapshot.',
    input: Tools.ReadInput,
    opensUrl: true,
    command: 'read',
    readOnly: true,
    maxOutput: 1_000_000,
    timeoutSec: () => 120,
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
    timeoutSec: () => 120,
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
    title: 'Emulate device, media, location, network',
    description: 'Device/viewport, color scheme, reduced motion, geolocation, timezone, locale, offline, extra headers; reset:true clears all.',
    input: Tools.EmulateInput,
    command: 'emulate',
    render: renderGeneric,
  },
  {
    name: 'browser_network',
    title: 'Record or intercept network traffic',
    description: 'record → act → stop (summary, or json/har file). intercept: block / mock / modify requests; unintercept to stop.',
    input: Tools.NetworkInput,
    command: 'network',
    timeoutSec: (a) => (a.action === 'stop' ? 300 : 60),
    render: renderNetwork,
  },
  {
    name: 'browser_clipboard',
    title: 'Read or write the clipboard',
    description: 'Read or write plain text on the system clipboard (explicit calls only).',
    input: Tools.ClipboardInput,
    command: 'clipboard',
    tab: 'none',
    render: (r) => ({ text: r.text !== undefined ? `Clipboard: ${r.text}` : `Wrote ${r.written} chars to the clipboard.` }),
  },
  {
    name: 'browser_download_images',
    title: 'Download images from a page',
    description: 'Save the images of a page (or url) to disk, skipping icons smaller than minWidth×minHeight.',
    input: Tools.DownloadImagesInput,
    opensUrl: true,
    command: 'downloadImages',
    route: Routes.downloadImages,
    timeoutSec: () => 180,
    render: (r) => ({
      text: `Saved ${r.images?.length ?? 0} image(s) to ${r.saveDir} (${r.skipped ?? 0} skipped)\n${(r.images ?? []).slice(0, 50).map((i: { path: string; width?: number; height?: number }) => `- ${i.path}${i.width ? ` (${i.width}×${i.height})` : ''}`).join('\n')}`,
    }),
  },
  {
    name: 'browser_evaluate',
    title: 'Run JavaScript in the page',
    description: 'Evaluate an expression (or a function body with return) in the page. With ref/selector the element is available as `el`. Enabled by BYOB_ALLOW_EVAL=1.',
    input: Tools.EvaluateInput,
    command: 'evaluate',
    enabled: evalAllowed,
    render: renderEvaluate,
  },
];

export function registerAllTools(server: McpServer): void {
  for (const s of specs) register(server, s);
  register(server, batchSpec(specs));
}
