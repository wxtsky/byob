import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TypeInput, TypeOutput } from '@byob/shared';
import { bridgePost } from '../bridge-client.js';
import { asErrorEnvelope, toMcpError } from '../error-mapper.js';

export function registerBrowserType(server: McpServer): void {
  server.registerTool(
    'browser_type',
    {
      title: 'Type text into an element',
      description:
        'Focus the element matching the selector, then type the given text. ' +
        'Optionally clears the field first and/or presses Enter after. ' +
        'Optionally pass framePath:[<iframe-css-selector>, ...] to operate inside a nested iframe ' +
        '(each entry selects an <iframe> in the prior level). Empty/omitted = main page.',
      inputSchema: TypeInput.shape,
    },
    async (args) => {
      const { status, body } = await bridgePost('/type', args);
      if (status >= 400) return toMcpError(asErrorEnvelope(body, `bridge ${status}`));
      const parsed = TypeOutput.safeParse(body);
      if (!parsed.success) return toMcpError({ error: 'unknown', message: parsed.error.message });
      return { content: [{ type: 'text', text: JSON.stringify(parsed.data) }] };
    },
  );
}
