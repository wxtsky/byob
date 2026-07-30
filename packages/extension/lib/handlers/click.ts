import { ClickInput } from '@byob/shared';
import { tryAttachToTab } from '../cdp.js';
import { attachErrorEnvelope } from '../attach-error.js';
import { resolveFrame, evaluateInResolvedFrame, frameErrorToEnvelope } from '../frame-resolver.js';
import { toPageCoords } from '../frame-coords.js';
import { throwIfAborted } from '../signal-utils.js';
import { resolveByobIdxSelector } from './selector-resolver.js';

export async function handleClick(
  rawParams: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const params = ClickInput.parse(rawParams);
  // Translate `byob:idx=N` shorthand → `[data-byob-idx="N"]` before any
  // selector consumer sees it. The data-byob-idx attribute is set by the
  // in-page collector during browser_read (see clickable-detector.ts).
  // NOTE: indices are tied to the page load they were collected in — SPA
  // re-renders or full navigations invalidate them, requiring a fresh
  // browser_read.
  const selector =
    params.selector === undefined ? undefined : resolveByobIdxSelector(params.selector);

  const tabId = params.tabId ?? (await activeTabId());
  if (tabId === null) return { error: 'unknown', message: 'No active tab' };
  throwIfAborted(signal);

  const attachResult = await tryAttachToTab(tabId, signal);
  const { session } = attachResult;
  if (!session) {
    return attachErrorEnvelope(attachResult);
  }

  let frame;
  try {
    frame = await resolveFrame(session, params.framePath, signal);
  } catch (e) {
    const env = frameErrorToEnvelope(e);
    if (env) return env;
    throw e;
  }

  let coords: {
    xy: { x: number; y: number };
    elementText?: string;
  };
  if (selector !== undefined) {
    let resolved;
    try {
      resolved = await toPageCoords(
        session,
        params.framePath,
        frame,
        selector,
        resolveFrame,
        signal,
      );
    } catch (e) {
      const env = frameErrorToEnvelope(e);
      if (env) return env;
      throw e;
    }
    if (!resolved) {
      return { error: 'selector_not_found', message: `No element matched ${params.selector}` };
    }
    coords = resolved;
  } else {
    // Coordinates are viewport coordinates on the top-level tab, matching
    // the CUA surface. The refined schema guarantees both values exist.
    coords = { xy: { x: params.x!, y: params.y! } };
  }

  // Occlusion check: before dispatching, verify the element under the
  // (viewport-space) center is still our target. Without this, sticky
  // headers / cookie banners / modals silently swallow clicks but we'd
  // happily return success:true. Skip when caller passed force:true.
  if (selector !== undefined && !params.force) {
    const sel = JSON.stringify(selector);
    const occlusionExpr = `(() => {
      const target = document.querySelector(${sel});
      if (!target) return { _err: 'selector_not_found' };
      const r = target.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return { occluded: false, hidden: true };
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const top = document.elementFromPoint(cx, cy);
      if (!top) return { occluded: true, actualTag: null, actualText: null };
      // INPUT-LABEL pair counts as not occluded — clicking the label
      // is the same UX as clicking the input.
      const isLabelInputPair = (a, b) => {
        if (!a || !b) return false;
        if (a.tagName === 'LABEL' && (a.htmlFor === b.id || a.contains(b))) return true;
        if (b.tagName === 'LABEL' && (b.htmlFor === a.id || b.contains(a))) return true;
        return false;
      };
      if (top === target || target.contains(top) || top.contains(target) || isLabelInputPair(top, target)) {
        return { occluded: false };
      }
      // Describe the blocker the way a devtools inspector would. A bare tag
      // name rarely identifies an overlay; "div#cookie-banner.fixed.top-0"
      // tells the model exactly what it has to dismiss.
      const cls = typeof top.className === 'string'
        ? top.className.trim().split(/\\s+/).filter(Boolean).slice(0, 3)
        : [];
      const desc = top.tagName.toLowerCase()
        + (top.id ? '#' + top.id : '')
        + (cls.length ? '.' + cls.join('.') : '');
      return {
        occluded: true,
        actualTag: desc,
        actualText: (top.textContent || '').trim().slice(0, 80),
      };
    })()`;
    const check = await evaluateInResolvedFrame<{
      _err?: string;
      occluded?: boolean;
      hidden?: boolean;
      actualTag?: string | null;
      actualText?: string | null;
    }>(session, frame, occlusionExpr, { awaitPromise: false, returnByValue: true, signal });
    if (check._err === 'selector_not_found') {
      return { error: 'selector_not_found', message: `No element matched ${params.selector}` };
    }
    if (check.occluded) {
      return {
        error: 'element_not_visible',
        message: `Click point covered by <${check.actualTag ?? 'unknown'}>${check.actualText ? ': "' + check.actualText + '"' : ''}. Pass force:true to click through.`,
        hint: 'Common causes: cookie banner, sticky header, modal overlay. Dismiss the overlay first or set force:true.',
      };
    }
  }

  const modifierMask = (() => {
    let m = 0;
    if (params.modifiers.includes('Alt')) m |= 1;
    if (params.modifiers.includes('Control')) m |= 2;
    if (params.modifiers.includes('Meta')) m |= 4;
    if (params.modifiers.includes('Shift')) m |= 8;
    return m;
  })();

  const common = {
    x: coords.xy.x,
    y: coords.xy.y,
    button: params.button,
    clickCount: params.clickCount,
    modifiers: modifierMask,
  };
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...common }, signal);
  await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...common }, signal);
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...common }, signal);

  return { success: true as const, elementText: coords.elementText };
}

async function activeTabId(): Promise<number | null> {
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return t?.id ?? null;
}
