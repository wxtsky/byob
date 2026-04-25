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
  if (process.env.BYOB_ALLOW_EVAL === '1') {
    registerBrowserEval(server);
    console.error('[byob-mcp] browser_eval ENABLED via BYOB_ALLOW_EVAL=1');
  }
}
