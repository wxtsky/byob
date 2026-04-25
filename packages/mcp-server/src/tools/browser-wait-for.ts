import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WaitForInput, WaitForOutput } from '@byob/shared';
import { bridgePost } from '../bridge-client.js';
import { asErrorEnvelope, toMcpError } from '../error-mapper.js';

export function registerBrowserWaitFor(server: McpServer): void {
  server.registerTool(
    'browser_wait_for',
    {
      title: 'Wait for an element to appear / disappear',
      description:
        'Block until a CSS selector reaches the requested state (visible / hidden / attached / detached). ' +
        'Useful before clicking on async-rendered content.',
      inputSchema: WaitForInput.shape,
    },
    async (args) => {
      const { status, body } = await bridgePost('/wait-for', args);
      if (status >= 400) return toMcpError(asErrorEnvelope(body, `bridge ${status}`));
      const parsed = WaitForOutput.safeParse(body);
      if (!parsed.success) return toMcpError({ error: 'unknown', message: parsed.error.message });
      return { content: [{ type: 'text', text: JSON.stringify(parsed.data) }] };
    },
  );
}
