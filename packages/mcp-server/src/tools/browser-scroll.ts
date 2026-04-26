import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ScrollInputRaw, ScrollOutput } from '@byob/shared';
import { bridgePost } from '../bridge-client.js';
import { asErrorEnvelope, toMcpError } from '../error-mapper.js';

export function registerBrowserScroll(server: McpServer): void {
  server.registerTool(
    'browser_scroll',
    {
      title: 'Scroll a page',
      description:
        'Scroll the page to a position, an element, or absolute Y coordinate. ' +
        'Pass exactly one of `to: "top"|"bottom"`, `selector: <css>`, or `y: <number>`. ' +
        'Optionally pass framePath:[<iframe-css-selector>, ...] to operate inside a nested iframe.',
      inputSchema: ScrollInputRaw.shape,
    },
    async (args, extra) => {
      const { status, body } = await bridgePost('/scroll', args, { signal: extra.signal });
      if (status >= 400) return toMcpError(asErrorEnvelope(body, `bridge ${status}`));
      const parsed = ScrollOutput.safeParse(body);
      if (!parsed.success) return toMcpError({ error: 'unknown', message: parsed.error.message });
      return { content: [{ type: 'text', text: JSON.stringify(parsed.data) }] };
    },
  );
}
