import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { HoverInputRaw, HoverOutput } from '@byob/shared';
import { bridgePost } from '../bridge-client.js';
import { asErrorEnvelope, toMcpError } from '../error-mapper.js';

export function registerBrowserHover(server: McpServer): void {
  server.registerTool(
    'browser_hover',
    {
      title: 'Hover the mouse over an element',
      description:
        'Move the mouse over the element matching the given CSS selector to trigger ' +
        'tooltips, dropdown menus, or any :hover-driven UI. Sends real CDP mouse events. ' +
        'Optionally pass framePath:[<iframe-css-selector>, ...] for iframe context.',
      inputSchema: HoverInputRaw.shape,
    },
    async (args, extra) => {
      const { status, body } = await bridgePost('/hover', args, { signal: extra.signal });
      if (status >= 400) return toMcpError(asErrorEnvelope(body, `bridge ${status}`));
      const parsed = HoverOutput.safeParse(body);
      if (!parsed.success) return toMcpError({ error: 'unknown', message: parsed.error.message });
      return { content: [{ type: 'text', text: JSON.stringify(parsed.data) }] };
    },
  );
}
