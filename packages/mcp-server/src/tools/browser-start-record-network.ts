import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StartRecordNetworkInputRaw, StartRecordNetworkOutput } from '@byob/shared';
import { bridgePost } from '../bridge-client.js';
import { asErrorEnvelope, toMcpError } from '../error-mapper.js';

export function registerBrowserStartRecordNetwork(server: McpServer): void {
  server.registerTool(
    'browser_start_record_network',
    {
      title: 'Start recording network requests on a tab',
      description:
        'Begin recording HTTP/HTTPS requests, responses, bodies, timings, and ' +
        'WebSocket frames on a Chrome tab. Returns a recordingId immediately; ' +
        'pair with browser_stop_record_network to retrieve captured data. ' +
        'Defaults filter to xhr/fetch resourceTypes; pass resourceTypes=["*"] ' +
        'to capture everything. Auto-stops at maxRecords (default 500), after ' +
        'timeoutMs (default 5 min), or when the tab closes.',
      inputSchema: StartRecordNetworkInputRaw.shape,
    },
    async (args, extra) => {
      const { status, body } = await bridgePost('/record-network/start', args, { signal: extra.signal });
      if (status >= 400) return toMcpError(asErrorEnvelope(body, `bridge ${status}`));
      const parsed = StartRecordNetworkOutput.safeParse(body);
      if (!parsed.success) return toMcpError({ error: 'unknown', message: parsed.error.message });
      return { content: [{ type: 'text', text: JSON.stringify(parsed.data) }] };
    },
  );
}
