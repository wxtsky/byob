import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GoBackInput, GoBackOutput } from '@byob/shared';
import { bridgePost } from '../bridge-client.js';
import { asErrorEnvelope, toMcpError } from '../error-mapper.js';

export function registerBrowserGoBack(server: McpServer): void {
  server.registerTool(
    'browser_go_back',
    {
      title: 'Go back one step in browser history',
      description:
        'Go back one step in the browser history of the given tab and wait for the new page ' +
        'to load. Returns no_history when there is nothing to go back to.',
      inputSchema: GoBackInput.shape,
    },
    async (args, extra) => {
      const { status, body } = await bridgePost('/go-back', args, { signal: extra.signal });
      if (status >= 400) return toMcpError(asErrorEnvelope(body, `bridge ${status}`));
      const parsed = GoBackOutput.safeParse(body);
      if (!parsed.success) return toMcpError({ error: 'unknown', message: parsed.error.message });
      return { content: [{ type: 'text', text: JSON.stringify(parsed.data) }] };
    },
  );
}
