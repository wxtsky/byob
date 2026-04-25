import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ReadMarkdownInputRaw, ReadMarkdownOutput } from '@byob/shared';
import { bridgePost } from '../bridge-client.js';
import { asErrorEnvelope, toMcpError } from '../error-mapper.js';

export function registerBrowserReadMarkdown(server: McpServer): void {
  server.registerTool(
    'browser_read_markdown',
    {
      title: 'Read a webpage as clean markdown (article-mode)',
      description:
        'Open a URL or use an existing tab and convert the main article body to markdown using ' +
        "Mozilla Readability + turndown. Strips navigation / sidebars / ads / footer. Returns " +
        'title, byline, excerpt + the markdown body. Best for news, blog posts, docs. SPA-heavy ' +
        'sites may fail Readability — fall back to browser_read in that case. ' +
        'Optionally pass framePath:[<iframe-css-selector>, ...] to operate inside a nested iframe ' +
        '(each entry selects an <iframe> in the prior level). Empty/omitted = main page.',
      inputSchema: ReadMarkdownInputRaw.shape,
    },
    async (args, extra) => {
      const { status, body } = await bridgePost('/read-markdown', args, { signal: extra.signal });
      if (status >= 400) return toMcpError(asErrorEnvelope(body, `bridge ${status}`));
      const parsed = ReadMarkdownOutput.safeParse(body);
      if (!parsed.success) return toMcpError({ error: 'unknown', message: parsed.error.message });
      return { content: [{ type: 'text', text: JSON.stringify(parsed.data) }] };
    },
  );
}
