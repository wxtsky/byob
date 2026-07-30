/**
 * Frame addressing across same-origin iframes and OOPIFs.
 *
 * Walks a `framePath: string[]` of CSS selectors level-by-level:
 *   selector_i is matched in the document of the frame resolved at step i-1.
 *
 * Returns `{ frameId, contextId, sessionId? }` — the executionContextId is
 * what `Runtime.evaluate` needs to run code in the right frame, and
 * `sessionId` (when present) routes the command to an OOPIF child target
 * via flatten auto-attach.
 *
 * The execution-context registry is populated by listeners installed in
 * `entrypoints/background.ts` that subscribe to
 * `Runtime.executionContextCreated` / `Runtime.executionContextDestroyed`
 * events. For unit tests the registry can be seeded directly via
 * `_seedContextForTests`.
 */

import type { ErrorEnvelope } from '@byob/shared';

export interface ResolvedFrame {
  frameId: string;
  contextId: number;
  sessionId?: string;
}

export class FrameError extends Error implements ErrorEnvelope {
  error: ErrorEnvelope['error'];
  framePathIndex?: number;
  reason?: string;
  hint?: string;
  constructor(env: ErrorEnvelope) {
    super(env.message);
    this.error = env.error;
    this.framePathIndex = env.framePathIndex;
    this.reason = env.reason;
    this.hint = env.hint;
  }
}

interface FrameTreeNode {
  frame: { id: string; url: string; parentId?: string };
  childFrames?: FrameTreeNode[];
}
interface GetFrameTreeResult {
  frameTree: FrameTreeNode;
}
interface DescribeNodeResult {
  node: { nodeName: string; frameId?: string; nodeId: number };
}
interface EvalResult {
  result?: { objectId?: string; value?: unknown; type?: string };
}

/** The slice of CdpSession that frame-scoped helpers need. Exported so
 *  frame-coords and test doubles describe the same shape. */
export interface SessionLike {
  send<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T>;
  sendOnSession<T = unknown>(
    sessionId: string,
    method: string,
    params?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T>;
}

const contextRegistry = new Map<string, { contextId: number; sessionId?: string }>();

export function recordContext(
  frameId: string,
  contextId: number,
  sessionId?: string,
): void {
  contextRegistry.set(frameId, { contextId, sessionId });
}

/**
 * Reverse-lookup remove: CDP's `Runtime.executionContextDestroyed` only
 * carries the executionContextId, not the frameId. We scan the registry
 * O(n) — n is bounded by frame count per top-level page (rarely > 50)
 * so this stays cheap. Without this, contextRegistry grew unboundedly
 * over the SW lifetime and stale contextIds got handed back to CDP,
 * yielding "Cannot find context with specified id" errors.
 */
export function forgetContextById(contextId: number, sessionId?: string): void {
  for (const [frameId, v] of contextRegistry) {
    if (v.contextId !== contextId) continue;
    // When sessionId is provided (flatten OOPIF child), require it to match
    // so we don't accidentally drop a same-numbered context from a different
    // target. When omitted (parent session), match only on contextId.
    if (sessionId !== undefined && v.sessionId !== sessionId) continue;
    contextRegistry.delete(frameId);
    return;
  }
}

export function _seedContextForTests(
  frameId: string,
  v: { contextId: number; sessionId?: string },
): void {
  contextRegistry.set(frameId, v);
}

export function _resetContextRegistryForTests(): void {
  contextRegistry.clear();
}

function findFrameInTree(tree: FrameTreeNode, frameId: string): FrameTreeNode | null {
  if (tree.frame.id === frameId) return tree;
  for (const child of tree.childFrames ?? []) {
    const found = findFrameInTree(child, frameId);
    if (found) return found;
  }
  return null;
}

export async function resolveFrame(
  session: SessionLike,
  framePath: string[],
  signal?: AbortSignal,
): Promise<ResolvedFrame> {
  const initialTree = (
    await session.send<GetFrameTreeResult>('Page.getFrameTree', {}, signal)
  ).frameTree;
  const mainFrameId = initialTree.frame.id;
  // For each step we look for the just-discovered childFrameId in the tree
  // we already have; only refetch if it's not there yet (common when an
  // OOPIF child was attached but Page.getFrameTree hasn't reflected it).
  // This collapses N getFrameTree round-trips per N-deep framePath into 1
  // in the typical case.
  const findFrameLazy = async (childFrameId: string): Promise<FrameTreeNode | null> => {
    const inInitial = findFrameInTree(initialTree, childFrameId);
    if (inInitial) return inInitial;
    const refreshed = (
      await session.send<GetFrameTreeResult>('Page.getFrameTree', {}, signal)
    ).frameTree;
    return findFrameInTree(refreshed, childFrameId);
  };
  const tree = initialTree;
  const mainCtx = contextRegistry.get(mainFrameId);
  if (!mainCtx) {
    throw new FrameError({
      error: 'frame_attach_failed',
      message: `No execution context known for main frame ${mainFrameId}`,
      hint: 'CDP autoAttach may not have fired yet — retry once.',
    });
  }

  let currentCtx = mainCtx;
  let currentFrameId = mainFrameId;

  for (let i = 0; i < framePath.length; i++) {
    const selector = framePath[i]!;
    const expr = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      return el || null;
    })()`;
    const found = (currentCtx.sessionId
      ? await session.sendOnSession<EvalResult>(
          currentCtx.sessionId,
          'Runtime.evaluate',
          {
            contextId: currentCtx.contextId,
            expression: expr,
            returnByValue: false,
          },
          signal,
        )
      : await session.send<EvalResult>(
          'Runtime.evaluate',
          {
            contextId: currentCtx.contextId,
            expression: expr,
            returnByValue: false,
          },
          signal,
        )) as EvalResult;
    const objectId = found.result?.objectId;
    if (!objectId) {
      throw new FrameError({
        error: 'frame_not_found',
        message: `framePath[${i}] selector ${JSON.stringify(selector)} matched no element`,
        framePathIndex: i,
      });
    }

    const describeParams = { objectId };
    const describe = currentCtx.sessionId
      ? await session.sendOnSession<DescribeNodeResult>(
          currentCtx.sessionId,
          'DOM.describeNode',
          describeParams,
          signal,
        )
      : await session.send<DescribeNodeResult>('DOM.describeNode', describeParams, signal);
    const tag = (describe.node.nodeName || '').toLowerCase();
    if (tag !== 'iframe' && tag !== 'frame') {
      throw new FrameError({
        error: 'frame_not_found',
        message: `framePath[${i}] selector matched <${tag}>, expected <iframe>/<frame>`,
        framePathIndex: i,
        reason: 'not_an_iframe',
      });
    }
    const childFrameId = describe.node.frameId;
    if (!childFrameId) {
      throw new FrameError({
        error: 'frame_not_found',
        message: `framePath[${i}]: iframe element has no loaded frame (about:blank?)`,
        framePathIndex: i,
        reason: 'frame_blank',
      });
    }

    const node = await findFrameLazy(childFrameId);
    if (!node) {
      throw new FrameError({
        error: 'frame_navigation_during_op',
        message: `framePath[${i}]: frame ${childFrameId} disappeared from tree`,
        framePathIndex: i,
      });
    }

    const childCtx = contextRegistry.get(childFrameId);
    if (!childCtx) {
      throw new FrameError({
        error: 'frame_attach_failed',
        message: `framePath[${i}]: no executionContext recorded for frame ${childFrameId}`,
        framePathIndex: i,
        hint: 'For OOPIFs this can race the autoAttach event — retry once.',
      });
    }

    currentCtx = childCtx;
    currentFrameId = childFrameId;
  }

  return {
    frameId: currentFrameId,
    contextId: currentCtx.contextId,
    sessionId: currentCtx.sessionId,
  };
}

/**
 * Route a CDP command to the session that owns `frame`.
 *
 * Out-of-process iframes live on their own CDP session, so every command
 * aimed at a resolved frame has to pick `sendOnSession` over `send` based on
 * whether `frame.sessionId` is set. That two-line choice had drifted into
 * five hand-written copies across handlers and helpers; each one had to
 * independently remember to thread `signal` through, and one of them didn't.
 */
export async function sendInResolvedFrame<T = unknown>(
  session: SessionLike,
  frame: ResolvedFrame,
  method: string,
  params: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<T> {
  return frame.sessionId
    ? session.sendOnSession<T>(frame.sessionId, method, params, signal)
    : session.send<T>(method, params, signal);
}

export async function evaluateInResolvedFrame<T = unknown>(
  session: SessionLike,
  frame: ResolvedFrame,
  expression: string,
  opts: { awaitPromise?: boolean; returnByValue?: boolean; signal?: AbortSignal } = {},
): Promise<T> {
  const res = await sendInResolvedFrame<{
    result: { value?: T };
    exceptionDetails?: unknown;
  }>(
    session,
    frame,
    'Runtime.evaluate',
    {
      contextId: frame.contextId,
      expression,
      awaitPromise: opts.awaitPromise ?? true,
      returnByValue: opts.returnByValue ?? true,
    },
    opts.signal,
  );
  if (res.exceptionDetails) {
    throw new FrameError({
      error: 'eval_exception',
      message: `eval threw in frame ${frame.frameId}: ${JSON.stringify(res.exceptionDetails).slice(0, 300)}`,
    });
  }
  return res.result?.value as T;
}

/**
 * Centralized FrameError → ErrorEnvelope mapping. Returns null if the
 * thrown value is not a FrameError (caller should rethrow or wrap).
 */
export function frameErrorToEnvelope(e: unknown): {
  error: string;
  message: string;
  hint?: string;
  framePathIndex?: number;
  reason?: string;
} | null {
  if (e instanceof FrameError) {
    return {
      error: e.error,
      message: e.message,
      hint: e.hint,
      framePathIndex: e.framePathIndex,
      reason: e.reason,
    };
  }
  return null;
}
