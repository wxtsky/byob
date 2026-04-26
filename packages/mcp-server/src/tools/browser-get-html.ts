import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GetHtmlInputRaw, GetHtmlOutput } from '@byob/shared';
import { bridgePost } from '../bridge-client.js';
import { asErrorEnvelope, toMcpError } from '../error-mapper.js';

export function registerBrowserGetHtml(server: McpServer): void {
  server.registerTool(
    'browser_get_html',
    {
      title: 'Get raw HTML of an element or page',
      description:
        'Return outerHTML (default) or innerHTML of the element matching `selector` ' +
        '(default: "html" for the whole document). Truncated at maxBytes (default 256 KB, ' +
        'max 8 MB) on a UTF-8 boundary; truncated:true is set when this happens. ' +
        'Optionally pass framePath:[<iframe-css-selector>, ...] for iframe context.',
      inputSchema: GetHtmlInputRaw.shape,
    },
    async (args, extra) => {
      const { status, body } = await bridgePost('/get-html', args, { signal: extra.signal });
      if (status >= 400) return toMcpError(asErrorEnvelope(body, `bridge ${status}`));
      const parsed = GetHtmlOutput.safeParse(body);
      if (!parsed.success) return toMcpError({ error: 'unknown', message: parsed.error.message });
      return { content: [{ type: 'text', text: JSON.stringify(parsed.data) }] };
    },
  );
}
