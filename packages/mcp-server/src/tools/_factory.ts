import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZodObject, ZodRawShape } from 'zod';
import { Routes } from '@byob/shared';
import { bridgePost } from '../bridge-client.js';
import { asErrorEnvelope } from '../error-mapper.js';
import { budget, renderError, type Rendered } from '../format.js';
import { forgetTab, getWorkingTab, isOwnedTab, markOwned, noteTab } from '../state.js';

type Args = Record<string, any>;

/**
 * How a tool picks its tab when the agent doesn't pass tabId:
 *  - 'working': the session's working tab (unless a ref names its own tab)
 *  - 'navigate': the working tab only if this session opened it — never
 *    navigate the user's own tab away from under them
 *  - 'none': no default (the handler decides)
 */
export type TabPolicy = 'working' | 'navigate' | 'none';

export interface ToolSpec {
  name: string;
  title: string;
  description: string;
  input: ZodObject<ZodRawShape>;
  command: string;
  route?: string;
  tab?: TabPolicy;
  /** Bridge timeout for this call. */
  timeoutSec?: (args: Args) => number;
  enabled?: () => boolean;
  /** Validate / rewrite arguments on the Node side before they're sent. */
  prepare?: (args: Args) => Args | Promise<Args>;
  render: (result: Args, args: Args) => Rendered;
  /** Fully custom execution (browser_batch); bypasses the bridge call. */
  run?: (args: Args, signal?: AbortSignal) => Promise<Rendered & { isError?: boolean }>;
  readOnly?: boolean;
  /** `url` means "open this URL" (not a match pattern, as in browser_wait). */
  opensUrl?: boolean;
  /** Max rendered characters before the rest is parked in a file. */
  maxOutput?: number;
}

export class ToolError extends Error {
  constructor(public readonly envelope: Args) {
    super(String(envelope.message));
  }
}

function injectTab(spec: ToolSpec, args: Args): { args: Args; injected: boolean } {
  if (args.tabId !== undefined) return { args, injected: false };
  const working = getWorkingTab();
  if (working === undefined) return { args, injected: false };
  const policy = spec.tab ?? 'working';
  if (policy === 'none') return { args, injected: false };
  // A ref already identifies its tab; forcing the working tab could only
  // produce a "ref belongs to another tab" error.
  if (args.ref !== undefined || args.within !== undefined) return { args, injected: false };
  if (policy === 'navigate') {
    if (args.action && args.action !== 'goto') {
      // back / forward / reload on a tab the user owns could throw away their
      // unsaved work; that needs an explicit tabId.
      if (!isOwnedTab(working)) {
        throw new ToolError({
          error: 'invalid_argument',
          message: `browser_navigate ${args.action}: the working tab ${working} wasn't opened by this session.`,
          hint: `Pass tabId: ${working} if you really mean the user's tab.`,
        });
      }
      return { args: { ...args, tabId: working }, injected: true };
    }
    return isOwnedTab(working) && !args.newTab ? { args: { ...args, tabId: working }, injected: true } : { args, injected: false };
  }
  // Tools that open a URL reuse the working tab only when it's ours.
  if (spec.opensUrl && args.url !== undefined && !isOwnedTab(working)) return { args, injected: false };
  return { args: { ...args, tabId: working }, injected: true };
}

/** Call the extension for one tool; returns the raw result or throws ToolError. */
export async function execute(spec: ToolSpec, rawArgs: Args, signal?: AbortSignal): Promise<Args> {
  let args = spec.prepare ? await spec.prepare({ ...rawArgs }) : { ...rawArgs };
  if ((spec.tab ?? 'working') === 'navigate' && args.action && args.action !== 'goto' && args.tabId === undefined && getWorkingTab() === undefined) {
    throw new ToolError({
      error: 'invalid_argument',
      message: `browser_navigate ${args.action}: no working tab yet.`,
      hint: 'Pass tabId (see browser_tabs).',
    });
  }
  const first = injectTab(spec, args);
  args = first.args;
  for (let attempt = 0; ; attempt++) {
    const timeoutSec = spec.timeoutSec?.(args) ?? 90;
    const route = spec.route ?? Routes.call;
    const body = route === Routes.call ? { command: spec.command, params: args, timeoutSec } : { ...args, timeoutSec };
    const { status, body: res } = await bridgePost<Args>(route, body, { signal });
    if (status < 400) {
      if (typeof res.tabId === 'number') {
        if (res.closed) forgetTab(res.tabId);
        else noteTab(res.tabId, { opened: res.opened === true });
      }
      // Tabs the page opened because of our action are ours to drive too.
      for (const t of res.effects?.newTabs ?? []) markOwned(t.tabId);
      return res;
    }
    const env = asErrorEnvelope(res, `bridge ${status}`);
    // The remembered working tab was closed: forget it. Only opening a URL
    // may carry on (in a new tab); anything else would silently land on the
    // user's active tab.
    if (attempt === 0 && first.injected && env.error === 'tab_closed' && spec.opensUrl && args.url !== undefined) {
      forgetTab(args.tabId);
      const { tabId: _drop, ...rest } = args;
      void _drop;
      args = rest;
      continue;
    }
    if (first.injected && env.error === 'tab_closed') {
      forgetTab(args.tabId);
      env.message = `The working tab ${args.tabId} is gone. ${env.message}`;
      env.hint = 'browser_tabs lists open tabs; pass tabId or select one.';
    }
    throw new ToolError(env);
  }
}

/** Errors thrown on the Node side (prepare hooks) carry `code` / `hint`. */
export function toEnvelope(e: unknown): Args {
  if (e instanceof ToolError) return e.envelope;
  const x = e as { code?: unknown; hint?: unknown; message?: unknown };
  return {
    error: typeof x?.code === 'string' ? x.code : 'unknown',
    message: e instanceof Error ? e.message : String(e),
    ...(typeof x?.hint === 'string' ? { hint: x.hint } : {}),
  };
}

export async function runTool(spec: ToolSpec, args: Args, signal?: AbortSignal): Promise<Rendered & { isError?: boolean }> {
  try {
    if (spec.run) {
      const r = await spec.run(args, signal);
      return { ...r, text: budget(spec.name, r.text, spec.maxOutput) };
    }
    const res = await execute(spec, args, signal);
    const out = spec.render(res, args);
    return { ...out, text: budget(spec.name, out.text, spec.maxOutput) };
  } catch (e) {
    return { text: renderError(toEnvelope(e)), isError: true };
  }
}

export function register(server: McpServer, spec: ToolSpec): void {
  if (spec.enabled && !spec.enabled()) return;
  server.registerTool(
    spec.name,
    {
      title: spec.title,
      description: spec.description,
      inputSchema: spec.input.shape,
      ...(spec.readOnly ? { annotations: { readOnlyHint: true } } : {}),
    },
    async (args: Args, extra: { signal: AbortSignal }) => {
      const r = await runTool(spec, args, extra.signal);
      const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [
        { type: 'text', text: r.text },
      ];
      for (const img of r.images ?? []) content.push({ type: 'image', data: img.data, mimeType: img.mimeType });
      return r.isError ? { isError: true, content } : { content };
    },
  );
}
