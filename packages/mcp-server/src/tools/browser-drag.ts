import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DragInputRaw, DragOutput } from '@byob/shared';
import { bridgePost } from '../bridge-client.js';
import { asErrorEnvelope, toMcpError } from '../error-mapper.js';

export function registerBrowserDrag(server: McpServer): void {
  server.registerTool(
    'browser_drag',
    {
      title: 'Drag the mouse from one point to another',
      description:
        'Drag the mouse from `from` to `to` over `durationMs` (default 500ms) using ' +
        'linear interpolation in `steps` substeps (default 30). Each of `from` and `to` ' +
        "accepts either a CSS selector (drag the element's center) or `{x, y}` page " +
        'coordinates. Triggers mouse events; HTML5 dragstart/drag/dragend are NOT fired. ' +
        'Supports iframe (`framePath`).',
      inputSchema: DragInputRaw.shape,
    },
    async (args, extra) => {
      const { status, body } = await bridgePost('/drag', args, { signal: extra.signal });
      if (status >= 400) return toMcpError(asErrorEnvelope(body, `bridge ${status}`));
      const parsed = DragOutput.safeParse(body);
      if (!parsed.success) return toMcpError({ error: 'unknown', message: parsed.error.message });
      return { content: [{ type: 'text', text: JSON.stringify(parsed.data) }] };
    },
  );
}
