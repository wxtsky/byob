import { ClickInput } from '@byob/shared';
import { tryAttachToTab } from '../cdp.js';
import { resolveFrame, frameErrorToEnvelope } from '../frame-resolver.js';
import { toPageCoords } from '../frame-coords.js';
import { throwIfAborted } from '../signal-utils.js';

export async function handleClick(
  rawParams: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const params = ClickInput.parse(rawParams);

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
      params.selector,
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
