import { Tools } from '@byob/shared';
import type { CdpSession } from '../cdp.js';
import { keepAwakeStart, keepAwakeEnd } from '../keepalive.js';
import { refFor } from '../refs.js';
import { mainFrameLoc, resolveTarget, hasTarget } from '../dom/element.js';
import type { FrameLoc } from '../dom/frames.js';
import { buildSnapshot } from '../snapshot/build.js';
import { collectSnapshot, type CollectedFrame } from '../snapshot/collect.js';
import { renderDiff } from '../snapshot/diff.js';
import { attach, pickTab, tabSummary } from './_common.js';

export interface SnapshotOptions {
  interactive?: boolean;
  diff?: boolean;
  maxDepth?: number;
  maxChars?: number;
  ref?: string;
  selector?: string;
  framePath?: string[];
}

export interface SnapshotResult {
  tabId: number;
  url: string;
  title: string;
  text: string;
  refCount: number;
  nodeCount: number;
  truncated: boolean;
  version: number;
  diff?: { added: number; removed: number; unchanged: boolean; base: number };
}

interface Stored {
  lines: string[];
  version: number;
}
const last = new Map<string, Stored>();
/** Options of the most recent explicit snapshot per tab, reused for diffs
 *  after actions so the "before" and "after" are rendered the same way. */
const lastOpts = new Map<number, SnapshotOptions>();
/** Refs rendered by the latest snapshot of each tab (for annotated screenshots). */
const lastRefs = new Map<number, string[]>();
export function refsOfLastSnapshot(tabId: number): string[] {
  return lastRefs.get(tabId) ?? [];
}
let versionSeq = 0;

globalThis.chrome?.tabs?.onRemoved?.addListener((tabId) => {
  for (const k of [...last.keys()]) if (k.startsWith(`${tabId}|`)) last.delete(k);
  lastOpts.delete(tabId);
  lastRefs.delete(tabId);
});

/** Take a snapshot of `session`'s tab. Shared by browser_snapshot, actions
 *  with `snapshot:true`, and browser_find. */
export async function takeSnapshot(
  session: CdpSession,
  opts: SnapshotOptions,
  signal: AbortSignal,
): Promise<SnapshotResult> {
  const tabId = session.tabId;
  let start: FrameLoc;
  let scopeBackendId: number | undefined;
  if (hasTarget(opts)) {
    const el = await resolveTarget(session, opts, signal);
    start = el.frame;
    scopeBackendId = el.backendNodeId;
  } else {
    start = await mainFrameLoc(session, signal);
  }

  keepAwakeStart();
  let root: CollectedFrame;
  try {
    root = await collectSnapshot(session, start, signal);
  } finally {
    keepAwakeEnd();
  }

  const minted: string[] = [];
  const built = buildSnapshot(
    root,
    (frame, node, role, name, nth) => {
      if (node.backendDOMNodeId === undefined) return undefined;
      const f = frame as CollectedFrame;
      const r = refFor(tabId, {
        backendNodeId: node.backendDOMNodeId,
        frameId: f.loc.frameId,
        sessionId: f.loc.sessionId,
        loaderId: f.loaderId,
        role,
        name,
        nth,
      });
      minted.push(r);
      return r;
    },
    {
      interactive: opts.interactive,
      maxDepth: opts.maxDepth,
      maxChars: opts.maxChars,
      scopeBackendId,
    },
  );

  if (!hasTarget(opts)) lastRefs.set(tabId, minted);
  const key = `${tabId}|${opts.interactive ? 'i' : 'f'}|${opts.ref ?? ''}|${opts.selector ?? ''}|${(opts.framePath ?? []).join('>')}`;
  const prev = last.get(key);
  const version = ++versionSeq;
  last.set(key, { lines: built.lines, version });

  const info = await tabSummary(tabId);
  const base: SnapshotResult = {
    ...info,
    text: built.text,
    refCount: built.refCount,
    nodeCount: built.nodeCount,
    truncated: built.truncated,
    version,
  };
  if (opts.diff && prev) {
    const d = renderDiff(prev.lines, built.lines);
    // A diff that is most of the page is harder to read than the page.
    if (!d.unchanged && d.text.length > built.text.length * 0.7) return base;
    return {
      ...base,
      text: d.unchanged ? '' : d.text,
      diff: { added: d.added, removed: d.removed, unchanged: d.unchanged, base: prev.version },
    };
  }
  return base;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export async function handleSnapshot(raw: unknown, signal: AbortSignal): Promise<unknown> {
  const p = Tools.SnapshotInput.parse(raw);
  const tabId = await pickTab(p);
  const session = await attach(tabId, signal, 'snapshot');
  const { diff: _d, ...remember } = p;
  void _d;
  // A diff without explicit options compares like with like: same mode and
  // scope as the snapshot it is diffed against.
  const prev = lastOpts.get(tabId);
  const opts = p.diff && prev && p.interactive === undefined && !hasTarget(p) ? { ...prev, ...stripUndefined(p) } : p;
  if (!p.diff || !prev) lastOpts.set(tabId, remember);
  return takeSnapshot(session, opts, signal);
}

/** After an action with `snapshot:true`: diff against the last full snapshot. */
export async function snapshotAfter(
  session: CdpSession,
  want: boolean | undefined,
  signal: AbortSignal,
): Promise<{ snapshot?: SnapshotResult }> {
  if (!want) return {};
  try {
    const base = lastOpts.get(session.tabId) ?? { interactive: true };
    return { snapshot: await takeSnapshot(session, { ...base, diff: true }, signal) };
  } catch (e) {
    if ((e as { name?: string }).name === 'AbortError') throw e;
    return {};
  }
}
