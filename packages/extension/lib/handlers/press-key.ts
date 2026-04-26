import { PressKeyInput } from '@byob/shared';
import { tryAttachToTab } from '../cdp.js';
import { resolveFrame, frameErrorToEnvelope } from '../frame-resolver.js';
import { openOrReuse } from '../tab.js';
import { checkUrlAllowed, urlForbiddenError } from '../url-guard.js';
import { throwIfAborted } from '../signal-utils.js';

export async function handlePressKey(
  rawParams: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const params = PressKeyInput.parse(rawParams);
  if (params.url) {
    const guard = checkUrlAllowed(params.url);
    if (!guard.ok) return urlForbiddenError(guard.reason);
  }
  throwIfAborted(signal);

  const tab = await openOrReuse({ url: params.url, tabId: params.tabId, signal });

  const { session, reason } = await tryAttachToTab(tab.tabId, signal);
  if (!session) return attachErrorToEnvelope(reason);

  // Resolve frame to assert addressable, even though dispatchKeyEvent does not
  // route into nested frames — the validation is still useful for the caller.
  try {
    await resolveFrame(session, params.framePath, signal);
  } catch (e) {
    const env = frameErrorToEnvelope(e);
    if (env) return env;
    throw e;
  }

  const modifiers = (() => {
    let m = 0;
    if (params.modifiers.includes('Alt')) m |= 1;
    if (params.modifiers.includes('Control')) m |= 2;
    if (params.modifiers.includes('Meta')) m |= 4;
    if (params.modifiers.includes('Shift')) m |= 8;
    return m;
  })();

  const isPrintable = params.key.length === 1;
  const baseEvent = { key: params.key, modifiers };

  await session.send('Input.dispatchKeyEvent', { type: 'keyDown', ...baseEvent }, signal);
  if (isPrintable) {
    await session.send(
      'Input.dispatchKeyEvent',
      { type: 'char', text: params.key, ...baseEvent },
      signal,
    );
  }
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...baseEvent }, signal);

  const info = await chrome.tabs.get(tab.tabId).catch(() => null);
  return { tabId: tab.tabId, url: info?.url ?? params.url ?? '' };
}

function attachErrorToEnvelope(
  reason?: 'special_page' | 'tab_gone' | 'attach_failed',
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
