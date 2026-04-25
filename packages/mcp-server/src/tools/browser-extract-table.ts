import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ExtractTableInputRaw, ExtractTableOutput } from '@byob/shared';
import { bridgePost } from '../bridge-client.js';
import { asErrorEnvelope, toMcpError } from '../error-mapper.js';

export function registerBrowserExtractTable(server: McpServer): void {
  server.registerTool(
    'browser_extract_table',
    {
      title: 'Extract <table> elements from a page as JSON',
      description:
        "Walk every <table> matching a CSS selector (default 'table') in the user's real " +
        "Chrome and return cells as JSON. format='rows' returns string[][]; format='objects' " +
        'pairs each row with the header row to give Record<string,string>[]. 0 matches is ' +
        'not an error — returns tables:[]. Does NOT expand colspan/rowspan and does NOT ' +
        'support ARIA `role="table"` divs (use browser_read for those). ' +
        'Optionally pass framePath:[<iframe-css-selector>, ...] to operate inside a nested iframe ' +
        '(each entry selects an <iframe> in the prior level). Empty/omitted = main page.',
      inputSchema: ExtractTableInputRaw.shape,
    },
    async (args, extra) => {
      const { status, body } = await bridgePost('/extract-table', args, { signal: extra.signal });
      if (status >= 400) return toMcpError(asErrorEnvelope(body, `bridge ${status}`));
      const parsed = ExtractTableOutput.safeParse(body);
      if (!parsed.success) return toMcpError({ error: 'unknown', message: parsed.error.message });
      return { content: [{ type: 'text', text: JSON.stringify(parsed.data) }] };
    },
  );
}
