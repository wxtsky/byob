import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DownloadImagesInput, DownloadImagesOutput } from '@byob/shared';
import { bridgePost } from '../bridge-client.js';
import { asErrorEnvelope, toMcpError } from '../error-mapper.js';

export function registerBrowserDownloadImages(server: McpServer): void {
  server.registerTool(
    'browser_download_images',
    {
      title: 'Download every image on a page',
      description:
        'Open a URL, scroll to trigger lazy loaders, then save every <img> on the page (plus og:image / twitter:image) to local disk. ' +
        "Uses the user's logged-in session to fetch each image — works for images behind auth that a generic crawler can't reach. " +
        'Returns the local file path of every downloaded image. Default save dir is ~/.byob/downloads/<timestamp>/. ' +
        'Optionally pass framePath:[<iframe-css-selector>, ...] to operate inside a nested iframe ' +
        '(each entry selects an <iframe> in the prior level). Empty/omitted = main page.',
      inputSchema: DownloadImagesInput.shape,
    },
    async (args, extra) => {
      const { status, body } = await bridgePost('/download-images', args, { signal: extra.signal });
      if (status >= 400) return toMcpError(asErrorEnvelope(body, `bridge ${status}`));
      const parsed = DownloadImagesOutput.safeParse(body);
      if (!parsed.success) return toMcpError({ error: 'unknown', message: parsed.error.message });
      return { content: [{ type: 'text', text: JSON.stringify(parsed.data) }] };
    },
  );
}
