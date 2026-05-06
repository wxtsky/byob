import { NavigateInput } from '@byob/shared';
import { waitForLoad } from '../tab.js';
import { checkUrlAllowed, urlForbiddenError } from '../url-guard.js';
import { isAbortError, throwIfAborted } from '../signal-utils.js';
import { waitForNetworkIdle } from '../network-idle.js';

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
    // active:false — don't yank a background tab to the foreground when
    // the agent navigates it. Use browser_switch_tab if you want focus.
    await chrome.tabs.update(tabId, { url: params.url, active: false });
  }

  try {
    await waitForLoad(tabId, params.timeoutSec * 1000, signal);
  } catch (e) {
    if (isAbortError(e)) throw e;
    return { error: 'timeout', message: e instanceof Error ? e.message : String(e) };
  }

  // 'networkidle' uses a real PerformanceObserver inside the page (no CDP
  // attach, no yellow debug bar). Quiet window = 500 ms; ad / analytics
  // domains are filtered so persistent background pings don't block us.
  // See lib/network-idle.ts.
  if (params.waitUntil === 'networkidle') {
    // Cap the idle wait at user-supplied timeoutSec. The load wait above
    // runs against its own deadline (waitForLoad's own throw path), so
    // these stack additively rather than sharing a budget — networkidle
    // can extend total wall time up to ~2 × timeoutSec in worst case.
    const maxIdleMs = Math.max(1000, params.timeoutSec * 1000);
    await waitForNetworkIdle(tabId, maxIdleMs, signal);
  }

  const tab = await chrome.tabs.get(tabId);
  return { tabId, url: tab.url ?? params.url, title: tab.title ?? '' };
}
