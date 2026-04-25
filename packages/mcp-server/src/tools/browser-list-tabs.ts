import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ListTabsOutput } from '@byob/shared';
import { bridgeGet } from '../bridge-client.js';
import { asErrorEnvelope, toMcpError } from '../error-mapper.js';

export function registerBrowserListTabs(server: McpServer): void {
  server.registerTool(
    'browser_list_tabs',
    {
      title: "List all tabs in the user's browser",
      description: 'Returns id, url, title, active flag, and windowId for every open tab.',
      inputSchema: z.object({}).shape,
    },
    async (_args, extra) => {
      const { status, body } = await bridgeGet('/tabs', { signal: extra.signal });
      if (status >= 400) return toMcpError(asErrorEnvelope(body, `bridge ${status}`));
      const parsed = ListTabsOutput.safeParse(body);
      if (!parsed.success) return toMcpError({ error: 'unknown', message: parsed.error.message });
      return { content: [{ type: 'text', text: JSON.stringify(parsed.data) }] };
    },
  );
}
