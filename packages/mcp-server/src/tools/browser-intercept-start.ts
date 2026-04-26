import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InterceptStartInputRaw, InterceptStartOutput } from '@byob/shared';
import { bridgePost } from '../bridge-client.js';
import { asErrorEnvelope, toMcpError } from '../error-mapper.js';

export function registerBrowserInterceptStart(server: McpServer): void {
  server.registerTool(
    'browser_intercept_start',
    {
      title: 'Start a request-interception session',
      description:
        'Start a request-interception session in a tab. Provide an array of `rules`, ' +
        'each with `urlPattern` (glob) or `urlRegex`, optional `methods` filter, and ' +
        "one `action`: 'block' / 'fulfill' / 'modify' / 'modifyResponse' / 'passthrough'. " +
        'Rules match in array order. Returns `interceptId` for `browser_intercept_stop`. ' +
        'Until stopped, all matching requests in the tab are intercepted. The tool ' +
        'incurs 5–50 ms per request — fine for normal browsing, slow for hot loops.',
      inputSchema: InterceptStartInputRaw.shape,
    },
    async (args, extra) => {
      const { status, body } = await bridgePost('/intercept-start', args, { signal: extra.signal });
      if (status >= 400) return toMcpError(asErrorEnvelope(body, `bridge ${status}`));
      const parsed = InterceptStartOutput.safeParse(body);
      if (!parsed.success) return toMcpError({ error: 'unknown', message: parsed.error.message });
      return { content: [{ type: 'text', text: JSON.stringify(parsed.data) }] };
    },
  );
}
