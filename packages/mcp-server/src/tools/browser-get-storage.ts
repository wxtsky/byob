import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GetStorageInputRaw, GetStorageOutput } from '@byob/shared';
import { bridgePost } from '../bridge-client.js';
import { asErrorEnvelope, toMcpError } from '../error-mapper.js';

export function registerBrowserGetStorage(server: McpServer): void {
  server.registerTool(
    'browser_get_storage',
    {
      title: "Read localStorage / sessionStorage for the current page's origin",
      description:
        "Read `localStorage` and/or `sessionStorage` for the current page's origin. " +
        'Use to inspect SPA state, cached tokens, feature flags. Default `kind` is ' +
        "'both'. Truncated to 1MB by default (drops sessionStorage first, then trims " +
        'localStorage keys lexicographically). Supports iframe (`framePath`).',
      inputSchema: GetStorageInputRaw.shape,
    },
    async (args, extra) => {
      const { status, body } = await bridgePost('/get-storage', args, { signal: extra.signal });
      if (status >= 400) return toMcpError(asErrorEnvelope(body, `bridge ${status}`));
      const parsed = GetStorageOutput.safeParse(body);
      if (!parsed.success) return toMcpError({ error: 'unknown', message: parsed.error.message });
      return { content: [{ type: 'text', text: JSON.stringify(parsed.data) }] };
    },
  );
}
