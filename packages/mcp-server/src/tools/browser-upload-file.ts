import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { UploadFileInputRaw, UploadFileOutput } from '@byob/shared';
import { bridgePost } from '../bridge-client.js';
import { asErrorEnvelope, toMcpError } from '../error-mapper.js';

export function registerBrowserUploadFile(server: McpServer): void {
  server.registerTool(
    'browser_upload_file',
    {
      title: 'Upload local files to a <input type="file"> element',
      description:
        'Upload one or more local files to a `<input type="file">` element. `paths` ' +
        'must be ABSOLUTE paths on the same machine as Chrome (the bridge validates ' +
        'fs readability). Auto-fires `change` event so React/Vue forms detect the ' +
        'upload. Supports iframe (`framePath`).',
      inputSchema: UploadFileInputRaw.shape,
    },
    async (args, extra) => {
      const { status, body } = await bridgePost('/upload-file', args, { signal: extra.signal });
      if (status >= 400) return toMcpError(asErrorEnvelope(body, `bridge ${status}`));
      const parsed = UploadFileOutput.safeParse(body);
      if (!parsed.success) return toMcpError({ error: 'unknown', message: parsed.error.message });
      return { content: [{ type: 'text', text: JSON.stringify(parsed.data) }] };
    },
  );
}
