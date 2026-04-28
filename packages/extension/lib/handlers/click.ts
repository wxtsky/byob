import { ClickInput } from '@byob/shared';
import { tryAttachToTab } from '../cdp.js';
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
  const selector = resolveByobIdxSelector(params.selector);

  const tabId = params.tabId ?? (await activeTabId());
  if (tabId === null) return { error: 'unknown', message: 'No active tab' };
  throwIfAborted(signal);

  const { session, reason } = await tryAttachToTab(tabId, signal);
  if (!session) {
    if (reason === 'special_page') {
      return {
        error: 'url_forbidden',
        message: 'Active tab is on a special page (chrome://, devtools://, etc.) — CDP cannot attach.',
        hint: 'Switch to a regular http(s):// tab.',
      };
    }
    if (reason === 'tab_gone') return { error: 'tab_closed', message: 'Tab was closed.' };
    return {
      error: 'cdp_attach_failed',
      message: 'Could not attach Chrome debugger after 3 retries.',
      hint: 'Close DevTools (F12) on the target tab and retry.',
    };
  }

  let frame;
  try {
    frame = await resolveFrame(session, params.framePath, signal);
  } catch (e) {
    const env = frameErrorToEnvelope(e);
    if (env) return env;
    throw e;
  }

  let coords;
  try {
    coords = await toPageCoords(
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
  if (!coords) {
    return { error: 'selector_not_found', message: `No element matched ${params.selector}` };
  }

  // Occlusion check: before dispatching, verify the element under the
  // (viewport-space) center is still our target. Without this, sticky
  // headers / cookie banners / modals silently swallow clicks but we'd
  // happily return success:true. Skip when caller passed force:true.
  if (!params.force) {
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
      return {
        occluded: true,
        actualTag: top.tagName.toLowerCase(),
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
