import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StopRecordNetworkInput, StopRecordNetworkOutput } from '@byob/shared';
import { bridgePost } from '../bridge-client.js';
import { asErrorEnvelope, toMcpError } from '../error-mapper.js';

export function registerBrowserStopRecordNetwork(server: McpServer): void {
  server.registerTool(
    'browser_stop_record_network',
    {
      title: 'Stop a recording and return captured network records',
      description:
        'Stop a recording previously started with browser_start_record_network and ' +
        'return all captured records. Pass format="har" to also receive a HAR 1.2 ' +
        'archive (importable into Chrome DevTools / Charles / online viewers). ' +
        'WebSocket frames are emitted under the _webSocketMessages custom field on ' +
        'the matching HAR entry, matching Chrome DevTools "Save all as HAR" output.',
      inputSchema: StopRecordNetworkInput.shape,
    },
    async (args) => {
      const { status, body } = await bridgePost('/record-network/stop', args);
      if (status >= 400) return toMcpError(asErrorEnvelope(body, `bridge ${status}`));
      const parsed = StopRecordNetworkOutput.safeParse(body);
      if (!parsed.success) return toMcpError({ error: 'unknown', message: parsed.error.message });
      return { content: [{ type: 'text', text: JSON.stringify(parsed.data) }] };
    },
  );
}
