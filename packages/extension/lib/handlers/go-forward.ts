import { GoForwardInput } from '@byob/shared';
import { waitForLoad } from '../tab.js';
import { isAbortError, throwIfAborted } from '../signal-utils.js';

export async function handleGoForward(
  rawParams: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const params = GoForwardInput.parse(rawParams);
  throwIfAborted(signal);

  try {
    await chrome.tabs.goForward(params.tabId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/no.*history|cannot find/i.test(msg)) {
      return { error: 'no_history', message: 'No history to go forward to in this tab.' };
    }
    return { error: 'tab_closed', message: msg };
  }

  try {
    await waitForLoad(params.tabId, params.timeoutSec * 1000, signal);
  } catch (e) {
    if (isAbortError(e)) throw e;
    return { error: 'timeout', message: e instanceof Error ? e.message : String(e) };
  }

  const tab = await chrome.tabs.get(params.tabId).catch(() => null);
  if (!tab) return { error: 'tab_closed', message: 'Tab was closed during navigation.' };
  return { tabId: params.tabId, url: tab.url ?? '', title: tab.title ?? '' };
}
