import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SelectInputRaw, SelectOutput } from '@byob/shared';
import { bridgePost } from '../bridge-client.js';
import { asErrorEnvelope, toMcpError } from '../error-mapper.js';

export function registerBrowserSelect(server: McpServer): void {
  server.registerTool(
    'browser_select',
    {
      title: 'Select an option in a <select>',
      description:
        'Choose an <option> in a native <select> by exactly one of value, label, or index. ' +
        'Dispatches input + change events so React/Vue/etc see the change. ' +
        'Use this instead of browser_click for native dropdowns. ' +
        'Optionally pass framePath:[<iframe-css-selector>, ...] for iframe context.',
      inputSchema: SelectInputRaw.shape,
    },
    async (args, extra) => {
      const { status, body } = await bridgePost('/select', args, { signal: extra.signal });
      if (status >= 400) return toMcpError(asErrorEnvelope(body, `bridge ${status}`));
      const parsed = SelectOutput.safeParse(body);
      if (!parsed.success) return toMcpError({ error: 'unknown', message: parsed.error.message });
      return { content: [{ type: 'text', text: JSON.stringify(parsed.data) }] };
    },
  );
}
