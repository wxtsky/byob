import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GetConsoleLogsInputRaw, GetConsoleLogsOutput } from '@byob/shared';
import { bridgePost } from '../bridge-client.js';
import { asErrorEnvelope, toMcpError } from '../error-mapper.js';

export function registerBrowserGetConsoleLogs(server: McpServer): void {
  server.registerTool(
    'browser_get_console_logs',
    {
      title: 'Snapshot console output and JS exceptions from a page',
      description:
        "Read recent console.log/info/warn/error/debug entries plus uncaught JavaScript " +
        "exceptions from a tab in the user's real Chrome. Snapshot only — does not stream. " +
        "Useful for debugging frontend issues an AI agent is iterating on. Default level " +
        "filter is ['warn','error']; set includeExceptions:false to skip uncaught throws. " +
        'Pass either url (opens a tab) or tabId (existing tab).',
      inputSchema: GetConsoleLogsInputRaw.shape,
    },
    async (args) => {
      const { status, body } = await bridgePost('/get-console-logs', args);
      if (status >= 400) return toMcpError(asErrorEnvelope(body, `bridge ${status}`));
      const parsed = GetConsoleLogsOutput.safeParse(body);
      if (!parsed.success) return toMcpError({ error: 'unknown', message: parsed.error.message });
      return { content: [{ type: 'text', text: JSON.stringify(parsed.data) }] };
    },
  );
}
