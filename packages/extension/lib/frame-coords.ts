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

import { type ResolvedFrame, type SessionLike, sendInResolvedFrame } from './frame-resolver.js';

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

/** Frames to wait for a scrolled element's rect to stop moving. Ten frames is
 *  ~160ms of real animation, well past any sane scroll or reflow. */
const MAX_SETTLE_FRAMES = 10;
/** Fallback for one frame wait. requestAnimationFrame is throttled or halted
 *  in background tabs — which byob drives all the time — so each frame wait
 *  is raced against this timer to keep the loop bounded. */
const FRAME_WAIT_MS = 50;

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
    const res = await sendInResolvedFrame<{ result: { value: Rect | null } }>(
      session,
      parent,
      'Runtime.evaluate',
      {
        contextId: parent.contextId,
        expression: expr,
        returnByValue: true,
        awaitPromise: false,
      },
      signal,
    );
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
  // The rect must be read *after* the scroll has settled, not in the same
  // tick as the scrollIntoView call. Two things make the naive version wrong:
  // a page with `scroll-behavior: smooth` animates the scroll, and scrolling
  // itself can trigger lazy-loading or sticky-header layout shifts. Either
  // way the coordinates would already be stale by the time the mouse event
  // goes out on the next CDP round-trip, and the click lands somewhere else.
  //
  // `behavior: 'instant'` overrides the page's smooth-scroll CSS, then the
  // rect has to hold still for two consecutive frames before we trust it.
  // Each frame wait is raced against a timer because requestAnimationFrame is
  // throttled (or stopped) in background tabs, which byob routinely drives.
  const innerExpr = `(async () => {
    const el = document.querySelector(${JSON.stringify(elementSelector)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });

    const nextFrame = () => new Promise((resolve) => {
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(); } };
      requestAnimationFrame(done);
      setTimeout(done, ${FRAME_WAIT_MS});
    });
    const sameRect = (a, b) =>
      a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

    let prev = el.getBoundingClientRect();
    let stableFrames = 0;
    for (let i = 0; i < ${MAX_SETTLE_FRAMES}; i++) {
      await nextFrame();
      const cur = el.getBoundingClientRect();
      stableFrames = sameRect(prev, cur) ? stableFrames + 1 : 0;
      prev = cur;
      if (stableFrames >= 2) break;
    }

    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, text: (el.innerText || '').slice(0, 200) };
  })()`;
  const innerRes = await sendInResolvedFrame<{
    result: { value: (Rect & { text: string }) | null };
  }>(
    session,
    frame,
    'Runtime.evaluate',
    {
      contextId: frame.contextId,
      expression: innerExpr,
      returnByValue: true,
      awaitPromise: true,
    },
    signal,
  );
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
