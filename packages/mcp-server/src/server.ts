import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerAllTools } from './tools/index.js';
import { pruneOutputs } from './files.js';
import { leanToolList } from './lean-schema.js';

export const VERSION = '0.5.0';

export async function runMcpServer(): Promise<void> {
  const server = new McpServer({ name: 'byob', version: VERSION });
  registerAllTools(server);
  pruneOutputs();
  const transport = new StdioServerTransport();
  await server.connect(leanToolList(transport));
  // IMPORTANT: log to stderr only — stdout is the MCP protocol channel.
  console.error(`[byob-mcp] v${VERSION} connected on stdio`);
}
