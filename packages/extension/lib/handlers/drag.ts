import { DragInput } from '@byob/shared';
import { tryAttachToTab } from '../cdp.js';
import { resolveFrame, frameErrorToEnvelope } from '../frame-resolver.js';
import { toPageCoords, frameLocalToPageCoords } from '../frame-coords.js';
import { openOrReuse } from '../tab.js';
import { checkUrlAllowed, urlForbiddenError } from '../url-guard.js';
import { sleepWithSignal, throwIfAborted } from '../signal-utils.js';
import { attachErrorEnvelope } from '../attach-error.js';
import { resolveByobIdxSelector } from './selector-resolver.js';

export async function handleDrag(
  rawParams: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const params = DragInput.parse(rawParams);
  if (params.url) {
    const guard = checkUrlAllowed(params.url);
    if (!guard.ok) return urlForbiddenError(guard.reason);
  }
  throwIfAborted(signal);

  const tab = await openOrReuse({ url: params.url, tabId: params.tabId, signal });
  const { session, reason } = await tryAttachToTab(tab.tabId, signal);
  if (!session) {
    if (!tab.reused) await tab.cleanup();
    return attachErrorEnvelope(reason);
  }

  let frame;
  try {
    frame = await resolveFrame(session, params.framePath, signal);
  } catch (e) {
    const env = frameErrorToEnvelope(e);
    if (env) return env;
    throw e;
  }

  // Resolve from / to to page-absolute coords.
  let from: { x: number; y: number };
  let to: { x: number; y: number };
  try {
    if (typeof params.from === 'string') {
      // Translate `byob:idx=N` → `[data-byob-idx="N"]` for parity with the
      // other 8 selector-taking handlers.
      const fromSel = resolveByobIdxSelector(params.from);
      const r = await toPageCoords(session, params.framePath, frame, fromSel, resolveFrame, signal);
      if (!r) {
        return { error: 'selector_not_found', message: `No element matched ${params.from}` };
      }
      from = r.xy;
    } else {
      from = await frameLocalToPageCoords(
        session,
        params.framePath,
        resolveFrame,
        params.from.x,
        params.from.y,
        signal,
      );
    }
    if (typeof params.to === 'string') {
      const toSel = resolveByobIdxSelector(params.to);
      const r = await toPageCoords(session, params.framePath, frame, toSel, resolveFrame, signal);
      if (!r) {
        return { error: 'selector_not_found', message: `No element matched ${params.to}` };
      }
      to = r.xy;
    } else {
      to = await frameLocalToPageCoords(
        session,
        params.framePath,
        resolveFrame,
        params.to.x,
        params.to.y,
        signal,
      );
    }
  } catch (e) {
    const env = frameErrorToEnvelope(e);
    if (env) return env;
    throw e;
  }

  // Mouse sequence
  const button = params.button;
  const stepDelay = params.durationMs / params.steps;
  const t0 = Date.now();

  await session.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: from.x,
    y: from.y,
    button,
    clickCount: 1,
  }, signal);

  for (let i = 1; i <= params.steps; i++) {
    throwIfAborted(signal);
    await sleepWithSignal(stepDelay, signal);
    const t = i / params.steps;
    const x = Math.round(from.x + (to.x - from.x) * t);
    const y = Math.round(from.y + (to.y - from.y) * t);
    await session.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
      button,
    }, signal);
  }

  // Note: if the loop above was aborted via signal, this mouseReleased never
  // fires and the page is left with a held mouse button until the next
  // navigation (Chromium resets input state on tab nav/reload). Acceptable
  // tradeoff — same pattern as scroll/hover for cancelled streaming inputs.
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: to.x,
    y: to.y,
    button,
    clickCount: 1,
  }, signal);

  const tabInfo = await chrome.tabs.get(tab.tabId).catch(() => null);
  return {
    tabId: tab.tabId,
    url: tabInfo?.url ?? params.url ?? '',
    from,
    to,
    steps: params.steps,
    durationMs: Date.now() - t0,
  };
}

