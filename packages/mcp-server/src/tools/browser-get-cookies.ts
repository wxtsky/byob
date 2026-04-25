import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GetCookiesInputRaw, GetCookiesOutput } from '@byob/shared';
import { bridgePost } from '../bridge-client.js';
import { asErrorEnvelope, toMcpError } from '../error-mapper.js';

export function registerBrowserGetCookies(server: McpServer): void {
  server.registerTool(
    'browser_get_cookies',
    {
      title: "Read cookies from the user's browser for a domain",
      description:
        'Returns cookies (incl. value) for a given domain or URL. Useful for ' +
        'replaying authenticated requests via curl/fetch without re-opening Chrome. ' +
        'Honors Chrome partitioning (CHIPS). Either `domain` or `url` is required.',
      inputSchema: GetCookiesInputRaw.shape,
    },
    async (args) => {
      const { status, body } = await bridgePost('/cookies', args);
      if (status >= 400) return toMcpError(asErrorEnvelope(body, `bridge ${status}`));
      const parsed = GetCookiesOutput.safeParse(body);
      if (!parsed.success) return toMcpError({ error: 'unknown', message: parsed.error.message });
      return { content: [{ type: 'text', text: JSON.stringify(parsed.data) }] };
    },
  );
}
