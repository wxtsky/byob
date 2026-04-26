import { CloseTabInput } from '@byob/shared';
import { throwIfAborted } from '../signal-utils.js';

export async function handleCloseTab(
  rawParams: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const params = CloseTabInput.parse(rawParams);
  throwIfAborted(signal);
  try {
    await chrome.tabs.remove(params.tabId);
    return { tabId: params.tabId, closed: true as const };
  } catch (e) {
    return {
      error: 'tab_closed',
      message: e instanceof Error ? e.message : `tab ${params.tabId} not found`,
    };
  }
}
