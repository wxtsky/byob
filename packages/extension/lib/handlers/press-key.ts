import { PressKeyInput } from '@byob/shared';
import { tryAttachToTab } from '../cdp.js';
import { resolveFrame, frameErrorToEnvelope } from '../frame-resolver.js';
import { openOrReuse } from '../tab.js';
import { checkUrlAllowed, urlForbiddenError } from '../url-guard.js';
import { throwIfAborted } from '../signal-utils.js';
import { attachErrorEnvelope } from '../attach-error.js';

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
  if (!session) {
    // Attach failed: clean up the freshly-opened tab so users aren't left
    // with blank tabs accumulating after every failed call. Reused tabs
    // stay (they were already user-owned).
    if (!tab.reused) await tab.cleanup();
    return attachErrorEnvelope(reason);
  }

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

