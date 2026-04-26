import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { EmulateDeviceInputRaw, EmulateDeviceOutput } from '@byob/shared';
import { bridgePost } from '../bridge-client.js';
import { asErrorEnvelope, toMcpError } from '../error-mapper.js';

export function registerBrowserEmulateDevice(server: McpServer): void {
  server.registerTool(
    'browser_emulate_device',
    {
      title: 'Emulate a mobile/tablet device viewport, DPR, touch, and User-Agent',
      description:
        'Emulate a mobile/tablet device. Use `preset`: ' +
        "'iphone-17-pro-max' / 'iphone-17' / 'ipad-pro' / 'pixel-9-pro' / 'galaxy-s25-ultra' / 'desktop' " +
        "(`'desktop'` resets all overrides), or `custom: { width, height, deviceScaleFactor, mobile, userAgent? }`. " +
        'Effect persists until reset, debugger detach, or tab close. Some bot-detection ' +
        'frameworks fingerprint emulation via maxTouchPoints / screen scale — this tool ' +
        'cannot bypass that.',
      inputSchema: EmulateDeviceInputRaw.shape,
    },
    async (args, extra) => {
      const { status, body } = await bridgePost('/emulate-device', args, { signal: extra.signal });
      if (status >= 400) return toMcpError(asErrorEnvelope(body, `bridge ${status}`));
      const parsed = EmulateDeviceOutput.safeParse(body);
      if (!parsed.success) return toMcpError({ error: 'unknown', message: parsed.error.message });
      return { content: [{ type: 'text', text: JSON.stringify(parsed.data) }] };
    },
  );
}
