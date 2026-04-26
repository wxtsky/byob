import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InterceptStopInputRaw, InterceptStopOutput } from '@byob/shared';
import { bridgePost } from '../bridge-client.js';
import { asErrorEnvelope, toMcpError } from '../error-mapper.js';

export function registerBrowserInterceptStop(server: McpServer): void {
  server.registerTool(
    'browser_intercept_stop',
    {
      title: 'Stop a request-interception session',
      description:
        'Stop a `browser_intercept_start` session by `interceptId`. Returns ' +
        '`{ totalRequests, hitsByRule: [{ ruleIndex, count, sampleUrls }], durationMs, ' +
        "endedReason: 'user_stop' | 'tab_closed' | 'wake_recovery' }`. " +
        'Returns `intercept_not_found` if the id was already drained or never existed.',
      inputSchema: InterceptStopInputRaw.shape,
    },
    async (args, extra) => {
      const { status, body } = await bridgePost('/intercept-stop', args, { signal: extra.signal });
      if (status >= 400) return toMcpError(asErrorEnvelope(body, `bridge ${status}`));
      const parsed = InterceptStopOutput.safeParse(body);
      if (!parsed.success) return toMcpError({ error: 'unknown', message: parsed.error.message });
      return { content: [{ type: 'text', text: JSON.stringify(parsed.data) }] };
    },
  );
}
