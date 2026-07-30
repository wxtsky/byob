import { HoverInput } from '@byob/shared';
import { tryAttachToTab } from '../cdp.js';
import { resolveFrame, frameErrorToEnvelope } from '../frame-resolver.js';
import { toPageCoords } from '../frame-coords.js';
import { openOrReuse } from '../tab.js';
import { checkUrlAllowed, urlForbiddenError } from '../url-guard.js';
import { throwIfAborted } from '../signal-utils.js';
import { attachErrorEnvelope } from '../attach-error.js';
import { resolveByobIdxSelector } from './selector-resolver.js';

export async function handleHover(
  rawParams: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const params = HoverInput.parse(rawParams);
  // Translate `byob:idx=N` → `[data-byob-idx="N"]` from the previous read.
  const selector =
    params.selector === undefined ? undefined : resolveByobIdxSelector(params.selector);
  if (params.url) {
    const guard = checkUrlAllowed(params.url);
    if (!guard.ok) return urlForbiddenError(guard.reason);
  }
  throwIfAborted(signal);

  const tab = await openOrReuse({ url: params.url, tabId: params.tabId, signal });

  const attachResult = await tryAttachToTab(tab.tabId, signal);
  const { session } = attachResult;
  if (!session) {
    // Attach failed: clean up the freshly-opened tab so users aren't left
    // with blank tabs accumulating after every failed call. Reused tabs
    // stay (they were already user-owned).
    if (!tab.reused) await tab.cleanup();
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

  let coords: { xy: { x: number; y: number } };
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
    coords = { xy: { x: params.x!, y: params.y! } };
  }

  // Move from a point off the element first, then to the target — some hover
  // intent detectors only fire on a real movement delta.
  const farX = Math.max(0, coords.xy.x - 200);
  const farY = Math.max(0, coords.xy.y - 200);
  await session.send(
    'Input.dispatchMouseEvent',
    { type: 'mouseMoved', x: farX, y: farY, button: 'none' },
    signal,
  );
  await session.send(
    'Input.dispatchMouseEvent',
    { type: 'mouseMoved', x: coords.xy.x, y: coords.xy.y, button: 'none' },
    signal,
  );

  const info = await chrome.tabs.get(tab.tabId).catch(() => null);
  return { tabId: tab.tabId, url: info?.url ?? params.url ?? '' };
}
