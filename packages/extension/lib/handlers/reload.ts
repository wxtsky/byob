import { ReloadInput } from '@byob/shared';
import { isAbortError, throwIfAborted } from '../signal-utils.js';
import { checkTabAccess } from '../tab-access.js';
import { waitForLoad } from '../tab.js';

export async function handleReload(
  rawParams: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const params = ReloadInput.parse(rawParams);
  throwIfAborted(signal);
  const access = await checkTabAccess(params.tabId, { allowForbiddenProtocol: true });
  if (!access.ok) return access.error;

  await chrome.tabs.reload(params.tabId);
  try {
    await waitForLoad(params.tabId, params.timeoutSec * 1000, signal);
  } catch (error) {
    if (isAbortError(error)) throw error;
    return {
      error: 'timeout',
      message: error instanceof Error ? error.message : String(error),
    };
  }

  const tab = await chrome.tabs.get(params.tabId);
  return {
    tabId: params.tabId,
    url: tab.url ?? '',
    title: tab.title ?? '',
  };
}
