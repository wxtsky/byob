/**
 * browser_batch — several steps in one call. Each step runs through exactly
 * the same path as the standalone tool (tab defaults, validation, errors),
 * so a batch is just fewer round trips, not a second code path.
 *
 * A step may use any tool currently in the agent's tool list: extra tools
 * (browser_network, …) only after browser_enable_tools turned them on, so a
 * batch never runs a tool whose schema the agent hasn't been shown.
 */
import { Tools } from '@byob/shared';
import { renderError, snapshotBlock } from '../format.js';
import { execute, toEnvelope, ToolError, type ToolSpec } from './_factory.js';

export function batchSpec(all: ToolSpec[], isActive: (spec: ToolSpec) => boolean): ToolSpec {
  const byShort = new Map<string, ToolSpec>();
  for (const s of all) {
    if (s.enabled && !s.enabled()) continue;
    byShort.set(s.name.replace(/^browser_/, ''), s);
  }
  const snapshot = byShort.get('snapshot')!;

  const spec: ToolSpec = {
    name: 'browser_batch',
    title: 'Run several browser steps in one call',
    description: `Several steps in one call, e.g. fill + submit: [{tool:"type",args:{ref:"e3",text:"a@b.c"}},{tool:"click",args:{ref:"e9"}}]. Any listed browser_* tool without the prefix. Stops at the first failure unless stopOnError:false.`,
    input: Tools.BatchInput,
    command: 'batch',
    tab: 'none',
    render: () => ({ text: '' }),
    run: (a, signal) => run(a, signal),
  };

  /** Why a step can't run, or null. */
  function refuse(name: string, s: ToolSpec | undefined): string | null {
    if (!s) {
      const names = [...byShort.values()].filter(isActive).map((x) => x.name.replace(/^browser_/, '')).join(', ');
      return `unknown tool "${name}" (available: ${names})`;
    }
    if (!isActive(s)) return `${s.name} is not enabled — call browser_enable_tools {groups:["${s.group}"]} first`;
    return null;
  }

  async function run(args: Record<string, any>, signal?: AbortSignal): Promise<{ text: string; isError?: boolean }> {
    const steps = args.steps as Array<{ tool: string; args?: Record<string, unknown> }>;
    const lines: string[] = [];
    let failed = false;
    let lastTab: number | undefined;
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      const short = step.tool.replace(/^browser_/, '');
      const s = short === 'batch' || short === 'enable_tools' ? undefined : byShort.get(short);
      const refused = refuse(step.tool, s);
      if (refused || !s) {
        lines.push(`${i + 1}. ✗ ${refused}`);
        failed = true;
        if (args.stopOnError !== false) break;
        continue;
      }
      try {
        const parsed = s.input.parse(step.args ?? {});
        const res = await execute(s, parsed, signal);
        if (typeof res.tabId === 'number') lastTab = res.tabId;
        // Actions: their summary + effects. Observations (snapshot, read,
        // find, console, …) are the point of the step, so keep them whole.
        const full = s.render(res, parsed).text;
        const text = s.readOnly || s.name === 'browser_find' ? full : full.split('\n').filter((l) => !l.startsWith('Tab ') && !l.startsWith('URL: ')).slice(0, 4).join('\n');
        lines.push(`${i + 1}. ✓ ${text.replace(/\n/g, '\n   ')}`);
      } catch (e) {
        failed = true;
        const env = e instanceof ToolError ? e.envelope : (e as Error).name === 'ZodError' ? { error: 'invalid_argument', message: (e as Error).message } : toEnvelope(e);
        lines.push(`${i + 1}. ✗ ${step.tool}: ${renderError(env).replace(/\n/g, ' — ')}`);
        if (args.stopOnError !== false) {
          if (i < steps.length - 1) lines.push(`(stopped; ${steps.length - i - 1} step(s) not run)`);
          break;
        }
      }
    }
    if (args.snapshot) {
      try {
        const res = await execute(snapshot, { diff: true, ...(lastTab !== undefined ? { tabId: lastTab } : {}) }, signal);
        lines.push(snapshotBlock(res).trim());
      } catch (e) {
        if (e instanceof ToolError) lines.push(renderError(e.envelope));
      }
    }
    return { text: lines.join('\n'), isError: failed };
  }

  return spec;
}
