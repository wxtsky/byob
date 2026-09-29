/**
 * Tool profiles. Every tool definition is paid for in the agent's context on
 * every turn, so by default ("core") the rarely needed tools are registered
 * but hidden; browser_enable_tools shows them on demand and tells the client
 * with notifications/tools/list_changed. BYOB_TOOLS=full lists everything
 * from the start (for clients that ignore list_changed).
 */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Tools } from '@byob/shared';
import type { ToolSpec } from './_factory.js';

export type ToolProfile = 'core' | 'full';

export function toolProfile(env: NodeJS.ProcessEnv = process.env): ToolProfile {
  return env.BYOB_TOOLS === 'full' ? 'full' : 'core';
}

export function enableToolsSpec(server: McpServer, specs: ToolSpec[], handles: Map<string, RegisteredTool>): ToolSpec {
  return {
    name: 'browser_enable_tools',
    title: 'Enable more browser tools',
    description:
      'Turn on tools that are off by default to save context: network (record/intercept traffic), emulate (device, dark mode, geolocation…), inspect (element styles, Web Vitals), clipboard, download_images, evaluate (page JS; needs BYOB_ALLOW_EVAL=1).',
    input: Tools.EnableToolsInput,
    command: 'enableTools',
    tab: 'none',
    render: () => ({ text: '' }),
    run: async (a) => {
      const groups = (a.groups as Tools.ExtraToolGroup[] | undefined)?.length ? (a.groups as Tools.ExtraToolGroup[]) : [...Tools.ExtraToolGroups];
      const enabled: string[] = [];
      const already: string[] = [];
      const unavailable: string[] = [];
      for (const g of new Set(groups)) {
        const spec = specs.find((s) => s.group === g);
        const handle = spec && handles.get(spec.name);
        if (!spec || !handle) {
          unavailable.push(g === 'evaluate' ? 'browser_evaluate (needs BYOB_ALLOW_EVAL=1 in the MCP server env)' : `browser_${g}`);
        } else if (handle.enabled) {
          already.push(spec.name);
        } else {
          // Flip them all, then one list_changed (enable() would send one each).
          handle.enabled = true;
          enabled.push(spec.name);
        }
      }
      if (enabled.length) server.sendToolListChanged();
      const lines = [
        enabled.length ? `Enabled ${enabled.join(', ')} — now in your tool list (if your client didn't refresh it, run them through browser_batch).` : '',
        already.length ? `Already enabled: ${already.join(', ')}.` : '',
        unavailable.length ? `Not available: ${unavailable.join(', ')}.` : '',
      ].filter(Boolean);
      return { text: lines.join('\n'), isError: enabled.length + already.length === 0 };
    },
  };
}
