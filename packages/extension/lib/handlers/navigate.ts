import { NavigateInput } from '@byob/shared';
import { waitForLoad } from '../tab.js';
// URL guard wired in Phase 5.

export async function handleNavigate(rawParams: unknown): Promise<unknown> {
  const params = NavigateInput.parse(rawParams);

  let tabId = params.tabId;
  if (tabId === undefined) {
    const created = await chrome.tabs.create({ url: params.url, active: false });
    tabId = created.id!;
  } else {
    await chrome.tabs.update(tabId, { url: params.url });
  }

  try {
    await waitForLoad(tabId, params.timeoutSec * 1000);
  } catch (e) {
    return { error: 'timeout', message: e instanceof Error ? e.message : String(e) };
  }

  // 'networkidle' isn't a real Chrome event; approximate with a short post-load delay.
  if (params.waitUntil === 'networkidle') {
    await new Promise((r) => setTimeout(r, 1500));
  }

  const tab = await chrome.tabs.get(tabId);
  return { tabId, url: tab.url ?? params.url, title: tab.title ?? '' };
}
