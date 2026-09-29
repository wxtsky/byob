/**
 * Frame bookkeeping for element-level operations.
 *
 * Every element byob touches lives in some frame, and every frame is reached
 * through one CDP session: the tab's own session for the main frame and
 * same-process iframes, or a flatten-attached child session for an
 * out-of-process iframe (OOPIF). Two things are tracked here:
 *
 *  1. The frame graph (frame → parent frame + owning <iframe> node), so a
 *     point inside a nested frame can be translated to tab-viewport
 *     coordinates for Input.dispatchMouseEvent.
 *  2. One isolated JavaScript world per frame. byob's own scripts run there:
 *     they share the DOM with the page but not its globals, so the page can
 *     neither observe byob (no `window.__byob*`) nor break it by patching
 *     prototypes.
 */
import type { CdpSession } from '../cdp.js';
import { ByobError, isContextGoneError } from '../errors.js';

export interface FrameLoc {
  frameId: string;
  /** Child CDP session for OOPIFs; undefined = the tab's own session. */
  sessionId?: string;
}

export interface FrameNode extends FrameLoc {
  parentFrameId?: string;
  /** Backend id of the <iframe>/<frame> element in the parent frame. */
  ownerBackendNodeId?: number;
}

const WORLD_NAME = '__byob_isolated__';

const graphs = new Map<number, Map<string, FrameNode>>();
const isolated = new Map<string, number>();

function isoKey(tabId: number, loc: FrameLoc): string {
  return `${tabId}|${loc.sessionId ?? ''}|${loc.frameId}`;
}

export function sendTo<T = unknown>(
  session: CdpSession,
  sessionId: string | undefined,
  method: string,
  params: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<T> {
  return sessionId
    ? session.sendOnSession<T>(sessionId, method, params, signal)
    : session.send<T>(method, params, signal);
}

export function recordFrame(tabId: number, node: FrameNode): void {
  let g = graphs.get(tabId);
  if (!g) {
    g = new Map();
    graphs.set(tabId, g);
  }
  const prev = g.get(node.frameId);
  g.set(node.frameId, { ...prev, ...node });
}

export function getFrameNode(tabId: number, frameId: string): FrameNode | undefined {
  return graphs.get(tabId)?.get(frameId);
}

interface FrameTreeNode {
  frame: { id: string; loaderId: string; url: string; parentId?: string };
  childFrames?: FrameTreeNode[];
}

export async function getFrameTree(
  session: CdpSession,
  sessionId: string | undefined,
  signal?: AbortSignal,
): Promise<FrameTreeNode> {
  const r = await sendTo<{ frameTree: FrameTreeNode }>(session, sessionId, 'Page.getFrameTree', {}, signal);
  return r.frameTree;
}

export function findInTree(tree: FrameTreeNode, frameId: string): FrameTreeNode | null {
  if (tree.frame.id === frameId) return tree;
  for (const c of tree.childFrames ?? []) {
    const f = findInTree(c, frameId);
    if (f) return f;
  }
  return null;
}

/** Main frame id + document identity of the tab. */
export async function mainFrameInfo(
  session: CdpSession,
  signal?: AbortSignal,
): Promise<{ frameId: string; loaderId: string; url: string }> {
  const t = await getFrameTree(session, undefined, signal);
  return { frameId: t.frame.id, loaderId: t.frame.loaderId, url: t.frame.url };
}

/** Current loaderId of a frame, or undefined when the frame is gone. */
export async function currentLoaderId(
  session: CdpSession,
  loc: FrameLoc,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const t = await getFrameTree(session, loc.sessionId, signal);
    return findInTree(t, loc.frameId)?.frame.loaderId;
  } catch (e) {
    if ((e as { name?: string }).name === 'AbortError') throw e;
    return undefined;
  }
}

/** Execution context id of byob's isolated world in `loc`, created on demand. */
export async function isolatedContext(
  session: CdpSession,
  loc: FrameLoc,
  signal?: AbortSignal,
): Promise<number> {
  const key = isoKey(session.tabId, loc);
  const cached = isolated.get(key);
  if (cached !== undefined) return cached;
  const r = await sendTo<{ executionContextId: number }>(
    session,
    loc.sessionId,
    'Page.createIsolatedWorld',
    { frameId: loc.frameId, worldName: WORLD_NAME, grantUniveralAccess: false },
    signal,
  );
  isolated.set(key, r.executionContextId);
  return r.executionContextId;
}

export function dropIsolatedContext(tabId: number, loc: FrameLoc): void {
  isolated.delete(isoKey(tabId, loc));
}

/** Called from the SW event hub when a context dies (navigation, frame removal). */
export function onContextDestroyed(tabId: number, sessionId: string | undefined, contextId: number): void {
  const prefix = `${tabId}|${sessionId ?? ''}|`;
  for (const [k, v] of isolated) {
    if (v === contextId && k.startsWith(prefix)) isolated.delete(k);
  }
}

export function onContextsCleared(tabId: number, sessionId: string | undefined): void {
  const prefix = `${tabId}|${sessionId ?? ''}|`;
  for (const k of [...isolated.keys()]) if (k.startsWith(prefix)) isolated.delete(k);
}

export function forgetTabFrames(tabId: number): void {
  graphs.delete(tabId);
  const prefix = `${tabId}|`;
  for (const k of [...isolated.keys()]) if (k.startsWith(prefix)) isolated.delete(k);
}

/**
 * Evaluate an expression in byob's isolated world of `loc`. Retries once
 * when the cached context turned out to be gone (the frame navigated).
 */
export async function evaluateIsolated<T = unknown>(
  session: CdpSession,
  loc: FrameLoc,
  expression: string,
  opts: { returnByValue?: boolean; awaitPromise?: boolean; signal?: AbortSignal } = {},
): Promise<{ value?: T; objectId?: string; subtype?: string; type?: string }> {
  for (let attempt = 0; ; attempt++) {
    const contextId = await isolatedContext(session, loc, opts.signal);
    try {
      const r = await sendTo<{
        result: { value?: T; objectId?: string; subtype?: string; type?: string };
        exceptionDetails?: { text?: string; exception?: { description?: string } };
      }>(
        session,
        loc.sessionId,
        'Runtime.evaluate',
        {
          expression,
          contextId,
          returnByValue: opts.returnByValue ?? true,
          awaitPromise: opts.awaitPromise ?? false,
        },
        opts.signal,
      );
      if (r.exceptionDetails) {
        const d = r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'error';
        throw new ByobError('eval_exception', `byob internal script failed: ${d.slice(0, 300)}`);
      }
      return r.result;
    } catch (e) {
      if (attempt === 0 && isContextGoneError(e)) {
        dropIsolatedContext(session.tabId, loc);
        continue;
      }
      throw e;
    }
  }
}

/** Run `fn` with `this` bound to a remote object, returning its JSON value. */
export async function callFunctionOn<T = unknown>(
  session: CdpSession,
  sessionId: string | undefined,
  objectId: string,
  fn: string,
  args: unknown[] = [],
  signal?: AbortSignal,
  opts: { awaitPromise?: boolean; returnByValue?: boolean } = {},
): Promise<T> {
  const r = await sendTo<{
    result: { value?: T; objectId?: string };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  }>(
    session,
    sessionId,
    'Runtime.callFunctionOn',
    {
      objectId,
      functionDeclaration: fn,
      arguments: args.map((value) => ({ value })),
      returnByValue: opts.returnByValue ?? true,
      awaitPromise: opts.awaitPromise ?? false,
    },
    signal,
  );
  if (r.exceptionDetails) {
    const d = r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'error';
    throw new ByobError('eval_exception', `byob internal script failed: ${d.slice(0, 300)}`);
  }
  return (opts.returnByValue === false ? (r.result.objectId as unknown) : r.result.value) as T;
}

// OOPIF child sessions, keyed by tab then frame id (for an out-of-process
// iframe the CDP targetId *is* its frame id). Fed by Target.attachedToTarget.
const oopifs = new Map<number, Map<string, string>>();

export function recordOopif(tabId: number, frameId: string, sessionId: string): void {
  let m = oopifs.get(tabId);
  if (!m) {
    m = new Map();
    oopifs.set(tabId, m);
  }
  m.set(frameId, sessionId);
}

export function forgetOopifSession(tabId: number, sessionId: string): void {
  const m = oopifs.get(tabId);
  if (!m) return;
  for (const [f, s] of m) if (s === sessionId) m.delete(f);
  onContextsCleared(tabId, sessionId);
}

export function oopifSession(tabId: number, frameId: string): string | undefined {
  return oopifs.get(tabId)?.get(frameId);
}

export function forgetTabOopifs(tabId: number): void {
  oopifs.delete(tabId);
}

/**
 * Offset of a frame's content box inside the tab viewport — the sum over the
 * ancestor chain of each owning <iframe>'s content-box origin. Border and
 * padding are included: getBoundingClientRect() is the border box, but the
 * child document starts at the content box.
 */
export async function frameOffset(
  session: CdpSession,
  frameId: string,
  signal?: AbortSignal,
): Promise<{ x: number; y: number }> {
  let x = 0;
  let y = 0;
  let cur = getFrameNode(session.tabId, frameId);
  for (let guard = 0; cur?.parentFrameId && guard < 20; guard++) {
    if (cur.ownerBackendNodeId === undefined) {
      throw new ByobError('frame_not_found', `No owner element recorded for frame ${cur.frameId}`,
        'Take a new browser_snapshot so byob can re-discover the iframe.');
    }
    const parent = getFrameNode(session.tabId, cur.parentFrameId) ?? { frameId: cur.parentFrameId };
    const ctx = await isolatedContext(session, parent, signal);
    const resolved = await sendTo<{ object: { objectId?: string } }>(
      session,
      parent.sessionId,
      'DOM.resolveNode',
      { backendNodeId: cur.ownerBackendNodeId, executionContextId: ctx },
      signal,
    );
    const oid = resolved.object.objectId;
    if (!oid) throw new ByobError('frame_not_found', `iframe for frame ${cur.frameId} is gone`);
    const o = await callFunctionOn<{ x: number; y: number }>(
      session,
      parent.sessionId,
      oid,
      `function () {
        const r = this.getBoundingClientRect();
        const cs = getComputedStyle(this);
        return {
          x: r.left + this.clientLeft + parseFloat(cs.paddingLeft || '0'),
          y: r.top + this.clientTop + parseFloat(cs.paddingTop || '0'),
        };
      }`,
      [],
      signal,
    );
    x += o.x;
    y += o.y;
    cur = parent;
  }
  return { x, y };
}
