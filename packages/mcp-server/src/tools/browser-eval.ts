import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { EvalInput, EvalOutput } from '@byob/shared';
import { bridgePost } from '../bridge-client.js';
import { asErrorEnvelope, toMcpError } from '../error-mapper.js';

export function registerBrowserEval(server: McpServer): void {
  server.registerTool(
    'browser_eval',
    {
      title: 'Execute JavaScript in a tab (DANGEROUS)',
      description:
        'Run arbitrary JavaScript in a browser tab via CDP Runtime.evaluate. ' +
        'DANGEROUS — full DOM and session access. Only use when other tools cannot ' +
        'accomplish the task. Audit-logged. Throttled to 5 calls per minute per tab. ' +
        'Optionally pass framePath:[<iframe-css-selector>, ...] to operate inside a nested iframe ' +
        '(each entry selects an <iframe> in the prior level). Empty/omitted = main page.',
      inputSchema: EvalInput.shape,
    },
    async (args) => {
      const { status, body } = await bridgePost('/eval', args);
      if (status >= 400) return toMcpError(asErrorEnvelope(body, `bridge ${status}`));
      const parsed = EvalOutput.safeParse(body);
      if (!parsed.success) return toMcpError({ error: 'unknown', message: parsed.error.message });
      return { content: [{ type: 'text', text: JSON.stringify(parsed.data) }] };
    },
  );
}
