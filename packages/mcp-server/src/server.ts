import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerAllTools } from './tools/index.js';

export async function runMcpServer(): Promise<void> {
  const server = new McpServer({ name: 'byob', version: '0.1.0' });
  registerAllTools(server);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // IMPORTANT: log to stderr only — stdout is the MCP protocol channel.
  console.error('[byob-mcp] connected on stdio');
}
