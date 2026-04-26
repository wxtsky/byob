import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PressKeyInputRaw, PressKeyOutput } from '@byob/shared';
import { bridgePost } from '../bridge-client.js';
import { asErrorEnvelope, toMcpError } from '../error-mapper.js';

export function registerBrowserPressKey(server: McpServer): void {
  server.registerTool(
    'browser_press_key',
    {
      title: 'Press a keyboard key',
      description:
        'Send a single keyboard event to the page (e.g. Enter, Escape, Tab, F5, ArrowDown, " "). ' +
        'modifiers may include any of Alt, Control, Shift, Meta. The key acts on the currently ' +
        'focused element — focus an input first via browser_click if needed. ' +
        'Optionally pass framePath:[<iframe-css-selector>, ...] for iframe context.',
      inputSchema: PressKeyInputRaw.shape,
    },
    async (args, extra) => {
      const { status, body } = await bridgePost('/press-key', args, { signal: extra.signal });
      if (status >= 400) return toMcpError(asErrorEnvelope(body, `bridge ${status}`));
      const parsed = PressKeyOutput.safeParse(body);
      if (!parsed.success) return toMcpError({ error: 'unknown', message: parsed.error.message });
      return { content: [{ type: 'text', text: JSON.stringify(parsed.data) }] };
    },
  );
}
