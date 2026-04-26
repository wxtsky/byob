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
import { registerBrowserStartRecordNetwork } from './browser-start-record-network.js';
import { registerBrowserStopRecordNetwork } from './browser-stop-record-network.js';
// v0.3 Batch 1
import { registerBrowserScroll } from './browser-scroll.js';
import { registerBrowserPressKey } from './browser-press-key.js';
import { registerBrowserSelect } from './browser-select.js';
import { registerBrowserCloseTab } from './browser-close-tab.js';
import { registerBrowserGoBack } from './browser-go-back.js';
import { registerBrowserGoForward } from './browser-go-forward.js';
import { registerBrowserHover } from './browser-hover.js';
import { registerBrowserGetHtml } from './browser-get-html.js';

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
  registerBrowserStartRecordNetwork(server);
  registerBrowserStopRecordNetwork(server);
  // v0.3 Batch 1
  registerBrowserScroll(server);
  registerBrowserPressKey(server);
  registerBrowserSelect(server);
  registerBrowserCloseTab(server);
  registerBrowserGoBack(server);
  registerBrowserGoForward(server);
  registerBrowserHover(server);
  registerBrowserGetHtml(server);
  if (process.env.BYOB_ALLOW_EVAL === '1') {
    registerBrowserEval(server);
    console.error('[byob-mcp] browser_eval ENABLED via BYOB_ALLOW_EVAL=1');
  }
}
