import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ReadInput, ReadOutput } from '@byob/shared';
import { bridgePost } from '../bridge-client.js';
import { asErrorEnvelope, toMcpError } from '../error-mapper.js';

export function registerBrowserRead(server: McpServer): void {
  server.registerTool(
    'browser_read',
    {
      title: "Read a webpage with the user's real browser",
      description:
        "Read full content from a webpage using the user's real Chrome browser " +
        '(with their cookies and active session). Auto-scrolls to load lazy content. ' +
        'Returns extracted text plus structured chunks with screen positions. ' +
        'Use this instead of WebFetch when the page needs login or has heavy JS. ' +
        'Optionally pass framePath:[<iframe-css-selector>, ...] to operate inside a nested iframe ' +
        '(each entry selects an <iframe> in the prior level). Empty/omitted = main page.',
      inputSchema: ReadInput.shape,
    },
    async (args, extra) => {
      const { status, body } = await bridgePost('/read', args, { signal: extra.signal });
      if (status >= 400) return toMcpError(asErrorEnvelope(body, `bridge returned ${status}`));
      const parsed = ReadOutput.safeParse(body);
      if (!parsed.success) {
        return toMcpError({
          error: 'unknown',
          message: `bridge returned malformed body: ${parsed.error.message}`,
        });
      }
      return { content: [{ type: 'text', text: JSON.stringify(parsed.data) }] };
    },
  );
}
