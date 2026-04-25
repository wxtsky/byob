import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ClickInput, ClickOutput } from '@byob/shared';
import { bridgePost } from '../bridge-client.js';
import { asErrorEnvelope, toMcpError } from '../error-mapper.js';

export function registerBrowserClick(server: McpServer): void {
  server.registerTool(
    'browser_click',
    {
      title: 'Click an element',
      description:
        'Click an element matching the given CSS selector in the active browser tab. ' +
        'Dispatches real mouse events via Chrome DevTools Protocol (not synthetic DOM events), ' +
        'so anti-bot heuristics see this as user input. ' +
        'Optionally pass framePath:[<iframe-css-selector>, ...] to operate inside a nested iframe ' +
        '(each entry selects an <iframe> in the prior level). Empty/omitted = main page.',
      inputSchema: ClickInput.shape,
    },
    async (args) => {
      const { status, body } = await bridgePost('/click', args);
      if (status >= 400) return toMcpError(asErrorEnvelope(body, `bridge ${status}`));
      const parsed = ClickOutput.safeParse(body);
      if (!parsed.success) return toMcpError({ error: 'unknown', message: parsed.error.message });
      return { content: [{ type: 'text', text: JSON.stringify(parsed.data) }] };
    },
  );
}
