import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CloseTabInput, CloseTabOutput } from '@byob/shared';
import { bridgePost } from '../bridge-client.js';
import { asErrorEnvelope, toMcpError } from '../error-mapper.js';

export function registerBrowserCloseTab(server: McpServer): void {
  server.registerTool(
    'browser_close_tab',
    {
      title: 'Close a browser tab',
      description: 'Close a browser tab by tabId. Returns tab_closed if the tab does not exist.',
      inputSchema: CloseTabInput.shape,
    },
    async (args, extra) => {
      const { status, body } = await bridgePost('/close-tab', args, { signal: extra.signal });
      if (status >= 400) return toMcpError(asErrorEnvelope(body, `bridge ${status}`));
      const parsed = CloseTabOutput.safeParse(body);
      if (!parsed.success) return toMcpError({ error: 'unknown', message: parsed.error.message });
      return { content: [{ type: 'text', text: JSON.stringify(parsed.data) }] };
    },
  );
}
