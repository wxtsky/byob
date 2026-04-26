/**
 * Cross-frame coordinate translation for Input.dispatchMouseEvent.
 *
 * Input.dispatchMouseEvent is page-level; when clicking inside a nested
 * iframe, we need to add the offset of every iframe element (in its parent
 * frame's viewport) to the target element's local rect.
 *
 * getBoundingClientRect() on an iframe element accounts for CSS
 * translate/scale set on that iframe (or its ancestors in the parent
 * frame). It does NOT decompose 2D rotation; spec § 11 explicitly accepts
 * that limitation.
 */

import type { ResolvedFrame } from './frame-resolver.js';

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface XY {
  x: number;
  y: number;
}

interface SessionLike {
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

/** Pure helper exported for unit tests. */
export function _accumulateOffset(rects: Array<{ x: number; y: number }>): XY {
  let x = 0;
  let y = 0;
  for (const r of rects) {
    x += r.x;
    y += r.y;
  }
  return { x, y };
}

/** Pure helper exported for unit tests. */
export function _composeFinalCoords(
  iframeOffsets: Array<{ x: number; y: number }>,
  elementRect: Rect,
): XY {
  const off = _accumulateOffset(iframeOffsets);
  return {
    x: Math.round(off.x + elementRect.x + elementRect.width / 2),
    y: Math.round(off.y + elementRect.y + elementRect.height / 2),
  };
}

async function collectIframeOffsets(
  session: SessionLike,
  framePath: string[],
  resolveFrameFn: (
    s: SessionLike,
    p: string[],
    signal?: AbortSignal,
  ) => Promise<ResolvedFrame>,
  signal?: AbortSignal,
): Promise<Array<{ x: number; y: number }>> {
  const offsets: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < framePath.length; i++) {
    const parentPath = framePath.slice(0, i);
    const parent = await resolveFrameFn(session, parentPath, signal);
    const expr = `(() => {
      const el = document.querySelector(${JSON.stringify(framePath[i])});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    })()`;
    const params = {
      contextId: parent.contextId,
      expression: expr,
      returnByValue: true,
      awaitPromise: false,
    };
    const res = (parent.sessionId
      ? await session.sendOnSession<{ result: { value: Rect | null } }>(
          parent.sessionId,
          'Runtime.evaluate',
          params,
          signal,
        )
      : await session.send<{ result: { value: Rect | null } }>(
          'Runtime.evaluate',
          params,
          signal,
        )) as {
      result: { value: Rect | null };
    };
    const rect = res.result.value;
    if (!rect) {
      throw new Error(`frame-coords: iframe element disappeared at framePath[${i}]`);
    }
    offsets.push({ x: rect.x, y: rect.y });
  }
  return offsets;
}

/**
 * Returns center-point page coordinates for an element inside a possibly
 * nested frame.
 */
export async function toPageCoords(
  session: SessionLike,
  framePath: string[],
  frame: ResolvedFrame,
  elementSelector: string,
  resolveFrameFn: (
    s: SessionLike,
    p: string[],
    signal?: AbortSignal,
  ) => Promise<ResolvedFrame>,
  signal?: AbortSignal,
): Promise<{ xy: XY; elementText: string } | null> {
  const innerExpr = `(() => {
    const el = document.querySelector(${JSON.stringify(elementSelector)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, text: (el.innerText || '').slice(0, 200) };
  })()`;
  const innerParams = {
    contextId: frame.contextId,
    expression: innerExpr,
    returnByValue: true,
    awaitPromise: false,
  };
  const innerRes = (frame.sessionId
    ? await session.sendOnSession<{ result: { value: (Rect & { text: string }) | null } }>(
        frame.sessionId,
        'Runtime.evaluate',
        innerParams,
        signal,
      )
    : await session.send<{ result: { value: (Rect & { text: string }) | null } }>(
        'Runtime.evaluate',
        innerParams,
        signal,
      )) as { result: { value: (Rect & { text: string }) | null } };
  const inner = innerRes.result.value;
  if (!inner) return null;

  const offsets = await collectIframeOffsets(session, framePath, resolveFrameFn, signal);

  const xy = _composeFinalCoords(offsets, inner);
  return { xy, elementText: inner.text };
}

/**
 * Convert a frame-local coordinate to page-absolute coordinates by walking
 * the framePath and accumulating each ancestor iframe's bounding-rect offset.
 * Same offset-walk logic that toPageCoords uses, exposed for callers that
 * have explicit (x, y) instead of a selector.
 */
export async function frameLocalToPageCoords(
  session: SessionLike,
  framePath: string[],
  resolveFrameFn: (
    s: SessionLike,
    p: string[],
    signal?: AbortSignal,
  ) => Promise<ResolvedFrame>,
  localX: number,
  localY: number,
  signal?: AbortSignal,
): Promise<XY> {
  if (framePath.length === 0) return { x: localX, y: localY };
  const offsets = await collectIframeOffsets(session, framePath, resolveFrameFn, signal);
  return _composeFinalCoords(offsets, { x: localX, y: localY, width: 0, height: 0 });
}
