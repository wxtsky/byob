import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerBrowserRead } from './browser-read.js';
import { registerBrowserClick } from './browser-click.js';
import { registerBrowserType } from './browser-type.js';
import { registerBrowserNavigate } from './browser-navigate.js';
import { registerBrowserWaitFor } from './browser-wait-for.js';

export function registerAllTools(server: McpServer): void {
  registerBrowserRead(server);
  registerBrowserClick(server);
  registerBrowserType(server);
  registerBrowserNavigate(server);
  registerBrowserWaitFor(server);
  // More tools registered in later phases.
}
