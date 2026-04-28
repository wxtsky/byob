import { HoverInput } from '@byob/shared';
import { tryAttachToTab } from '../cdp.js';
import { resolveFrame, frameErrorToEnvelope } from '../frame-resolver.js';
import { toPageCoords } from '../frame-coords.js';
import { openOrReuse } from '../tab.js';
import { checkUrlAllowed, urlForbiddenError } from '../url-guard.js';
import { throwIfAborted } from '../signal-utils.js';
import { resolveByobIdxSelector } from './selector-resolver.js';

export async function handleHover(
  rawParams: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const params = HoverInput.parse(rawParams);
  // Translate `byob:idx=N` → `[data-byob-idx="N"]` from the previous read.
  const selector = resolveByobIdxSelector(params.selector);
  if (params.url) {
    const guard = checkUrlAllowed(params.url);
    if (!guard.ok) return urlForbiddenError(guard.reason);
  }
  throwIfAborted(signal);

  const tab = await openOrReuse({ url: params.url, tabId: params.tabId, signal });

  const { session, reason } = await tryAttachToTab(tab.tabId, signal);
  if (!session) return attachErrorToEnvelope(reason);

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

function attachErrorToEnvelope(
  reason?: 'special_page' | 'tab_gone' | 'attach_failed' | 'flatten_unsupported',
): { error: string; message: string; hint?: string } {
  if (reason === 'special_page') {
    return {
      error: 'url_forbidden',
      message: 'Tab is on a special page (chrome://, devtools://, etc.) — CDP cannot attach.',
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
