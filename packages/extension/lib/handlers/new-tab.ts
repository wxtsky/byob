import { NewTabInput } from '@byob/shared';
import { throwIfAborted } from '../signal-utils.js';
import { waitForLoad } from '../tab.js';
import { checkUrlAllowed, urlForbiddenError } from '../url-guard.js';

export async function handleNewTab(
  rawParams: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const params = NewTabInput.parse(rawParams);
  if (params.url) {
    const guard = checkUrlAllowed(params.url);
    if (!guard.ok) return urlForbiddenError(guard.reason);
  }
  throwIfAborted(signal);

  const created = await chrome.tabs.create({
    url: params.url ?? 'about:blank',
    active: params.active,
  });
  const tabId = created.id;
  if (tabId === undefined) {
    return { error: 'unknown', message: 'Chrome created a tab without an id' };
  }

  if (params.url) {
    try {
      await waitForLoad(tabId, 30_000, signal);
    } catch {
      // Return the tab even if the site keeps loading indefinitely. The
      // caller can inspect it or wait for a specific element.
    }
  }
  const tab = await chrome.tabs.get(tabId);
  return {
    tabId,
    url: tab.url ?? params.url ?? 'about:blank',
    title: tab.title ?? '',
  };
}
