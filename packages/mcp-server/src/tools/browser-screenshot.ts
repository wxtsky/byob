import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ScreenshotInput, ScreenshotOutput } from '@byob/shared';
import { bridgePost } from '../bridge-client.js';
import { asErrorEnvelope, toMcpError } from '../error-mapper.js';

export function registerBrowserScreenshot(server: McpServer): void {
  server.registerTool(
    'browser_screenshot',
    {
      title: 'Screenshot a page (returns file path, not data)',
      description:
        'Capture a screenshot of a webpage and save it to disk. Returns the file PATH ' +
        '(not base64) — read the file with the Read tool when you actually need the image. ' +
        'Default save dir is ~/.byob/screenshots/. fullPage may fail for very long pages.',
      inputSchema: ScreenshotInput.shape,
    },
    async (args, extra) => {
      const { status, body } = await bridgePost('/screenshot', args, { signal: extra.signal });
      if (status >= 400) return toMcpError(asErrorEnvelope(body, `bridge ${status}`));
      const parsed = ScreenshotOutput.safeParse(body);
      if (!parsed.success) return toMcpError({ error: 'unknown', message: parsed.error.message });
      return { content: [{ type: 'text', text: JSON.stringify(parsed.data) }] };
    },
  );
}
