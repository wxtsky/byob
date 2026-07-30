/**
 * HTTP routes between mcp-server (client) and bridge (server) over the
 * unix-domain socket. Single source of truth — bridge-client.ts uses these
 * paths verbatim; bridge ipc-server matches POST tools by stripping the
 * leading slash and looking up `tools[stripped]`. Adding a new tool? Add a
 * row here, register a handler under the matching key in bridge/main.ts,
 * and append an entry in mcp-server/src/tools/all.ts.
 */
export const Routes = {
  read: '/read',
  click: '/click',
  type: '/type',
  navigate: '/navigate',
  waitFor: '/wait-for',
  screenshot: '/screenshot',
  cookies: '/cookies',
  // POST counterpart for browser_list_tabs. The browser-facing GET path is in
  // GetRoutes.listTabs; ipc-server forwards GET /tabs to this same handler.
  listTabs: '/__list-tabs',
  switchTab: '/tabs/switch',
  eval: '/eval',
  downloadImages: '/download-images',
  getConsoleLogs: '/get-console-logs',
  readMarkdown: '/read-markdown',
  extractTable: '/extract-table',
  recordNetworkStart: '/record-network/start',
  recordNetworkStop: '/record-network/stop',
  scroll: '/scroll',
  pressKey: '/press-key',
  select: '/select',
  closeTab: '/close-tab',
  goBack: '/go-back',
  goForward: '/go-forward',
  hover: '/hover',
  getHtml: '/get-html',
  setCookies: '/set-cookies',
  printPdf: '/print-pdf',
  getStorage: '/get-storage',
  getPerformance: '/get-performance',
  uploadFile: '/upload-file',
  interceptStart: '/intercept-start',
  interceptStop: '/intercept-stop',
  drag: '/drag',
  emulateDevice: '/emulate-device',
  snapshot: '/snapshot',
  newTab: '/tabs/new',
  reload: '/tabs/reload',
  getJsDialog: '/dialogs/get',
  handleJsDialog: '/dialogs/handle',
  history: '/history',
  clipboardReadText: '/clipboard/read-text',
  clipboardWriteText: '/clipboard/write-text',
} as const;

/** GET-only routes — no body required. */
export const GetRoutes = {
  listTabs: '/tabs',
  status: '/status',
} as const;

/** Strip the leading slash for use as a key in bridge `tools` map. */
export function routeKey(p: string): string {
  return p.startsWith('/') ? p.slice(1) : p;
}

export type RoutePathName = keyof typeof Routes;
export type RoutePath = (typeof Routes)[RoutePathName];
