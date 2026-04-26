import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GetPerformanceInputRaw, GetPerformanceOutput } from '@byob/shared';
import { bridgePost } from '../bridge-client.js';
import { asErrorEnvelope, toMcpError } from '../error-mapper.js';

export function registerBrowserGetPerformance(server: McpServer): void {
  server.registerTool(
    'browser_get_performance',
    {
      title: 'Get page performance metrics — Web Vitals + Navigation Timing',
      description:
        'Get page performance metrics — Core Web Vitals (LCP/CLS/INP/FCP/TTFB) and ' +
        'navigation timing (DCL, load, DNS, TCP, transfer size). Default samples for ' +
        '3000ms; tune `waitMs` for slow pages. INP requires real user interaction so ' +
        'it returns null on pages without any. `navigation` is null on internal ' +
        'browser pages (chrome://, about:blank).',
      inputSchema: GetPerformanceInputRaw.shape,
    },
    async (args, extra) => {
      const { status, body } = await bridgePost('/get-performance', args, { signal: extra.signal });
      if (status >= 400) return toMcpError(asErrorEnvelope(body, `bridge ${status}`));
      const parsed = GetPerformanceOutput.safeParse(body);
      if (!parsed.success) return toMcpError({ error: 'unknown', message: parsed.error.message });
      return { content: [{ type: 'text', text: JSON.stringify(parsed.data) }] };
    },
  );
}
