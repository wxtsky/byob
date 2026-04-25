import { NavigateInput } from '@byob/shared';
import { waitForLoad } from '../tab.js';
import { checkUrlAllowed, urlForbiddenError } from '../url-guard.js';
import { isAbortError, sleepWithSignal, throwIfAborted } from '../signal-utils.js';

export async function handleNavigate(
  rawParams: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const params = NavigateInput.parse(rawParams);
  const guard = checkUrlAllowed(params.url);
  if (!guard.ok) return urlForbiddenError(guard.reason);
  throwIfAborted(signal);

  let tabId = params.tabId;
  if (tabId === undefined) {
    const created = await chrome.tabs.create({ url: params.url, active: false });
    tabId = created.id!;
  } else {
    await chrome.tabs.update(tabId, { url: params.url });
  }

  try {
    await waitForLoad(tabId, params.timeoutSec * 1000, signal);
  } catch (e) {
    if (isAbortError(e)) throw e;
    return { error: 'timeout', message: e instanceof Error ? e.message : String(e) };
  }

  // 'networkidle' isn't a real Chrome event; approximate with a short post-load delay.
  if (params.waitUntil === 'networkidle') {
    await sleepWithSignal(1500, signal);
  }

  const tab = await chrome.tabs.get(tabId);
  return { tabId, url: tab.url ?? params.url, title: tab.title ?? '' };
}
