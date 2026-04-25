import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { NavigateInput, NavigateOutput } from '@byob/shared';
import { bridgePost } from '../bridge-client.js';
import { asErrorEnvelope, toMcpError } from '../error-mapper.js';

export function registerBrowserNavigate(server: McpServer): void {
  server.registerTool(
    'browser_navigate',
    {
      title: 'Navigate a tab to a URL',
      description:
        'Open a new tab (or reuse a given tabId) and navigate to the URL. ' +
        'Waits for the load event by default; pass waitUntil=networkidle for SPAs.',
      inputSchema: NavigateInput.shape,
    },
    async (args) => {
      const { status, body } = await bridgePost('/navigate', args);
      if (status >= 400) return toMcpError(asErrorEnvelope(body, `bridge ${status}`));
      const parsed = NavigateOutput.safeParse(body);
      if (!parsed.success) return toMcpError({ error: 'unknown', message: parsed.error.message });
      return { content: [{ type: 'text', text: JSON.stringify(parsed.data) }] };
    },
  );
}
