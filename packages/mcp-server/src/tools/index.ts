import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerBrowserRead } from './browser-read.js';

export function registerAllTools(server: McpServer): void {
  registerBrowserRead(server);
  // More tools registered in later phases.
}
