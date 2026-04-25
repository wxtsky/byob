import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SwitchTabInput, SwitchTabOutput } from '@byob/shared';
import { bridgePost } from '../bridge-client.js';
import { asErrorEnvelope, toMcpError } from '../error-mapper.js';

export function registerBrowserSwitchTab(server: McpServer): void {
  server.registerTool(
    'browser_switch_tab',
    {
      title: 'Activate a tab by id',
      description: 'Bring the given tab to the foreground (focus its window + make it active).',
      inputSchema: SwitchTabInput.shape,
    },
    async (args) => {
      const { status, body } = await bridgePost('/tabs/switch', args);
      if (status >= 400) return toMcpError(asErrorEnvelope(body, `bridge ${status}`));
      const parsed = SwitchTabOutput.safeParse(body);
      if (!parsed.success) return toMcpError({ error: 'unknown', message: parsed.error.message });
      return { content: [{ type: 'text', text: JSON.stringify(parsed.data) }] };
    },
  );
}
