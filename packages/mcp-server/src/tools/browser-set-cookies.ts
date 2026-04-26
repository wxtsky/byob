import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SetCookiesInputRaw, SetCookiesOutput } from '@byob/shared';
import { bridgePost } from '../bridge-client.js';
import { asErrorEnvelope, toMcpError } from '../error-mapper.js';

export function registerBrowserSetCookies(server: McpServer): void {
  server.registerTool(
    'browser_set_cookies',
    {
      title: "Write a cookie to the user's browser",
      description:
        "Write a cookie to the user's browser. Counterpart to `browser_get_cookies`. " +
        '`url` is required (chrome.cookies API uses it to derive default domain/path and ' +
        'enforce host permissions). `sameSite` must be lowercase: ' +
        "'no_restriction' / 'lax' / 'strict'. `partitionKey` is the top-level site for " +
        'CHIPS-partitioned cookies.',
      inputSchema: SetCookiesInputRaw.shape,
    },
    async (args, extra) => {
      const { status, body } = await bridgePost('/set-cookies', args, { signal: extra.signal });
      if (status >= 400) return toMcpError(asErrorEnvelope(body, `bridge ${status}`));
      const parsed = SetCookiesOutput.safeParse(body);
      if (!parsed.success) return toMcpError({ error: 'unknown', message: parsed.error.message });
      return { content: [{ type: 'text', text: JSON.stringify(parsed.data) }] };
    },
  );
}
