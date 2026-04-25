import { SwitchTabInput } from '@byob/shared';
import { throwIfAborted } from '../signal-utils.js';

export async function handleSwitchTab(
  rawParams: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const params = SwitchTabInput.parse(rawParams);
  throwIfAborted(signal);
  try {
    const t = await chrome.tabs.get(params.tabId);
    if (t.windowId !== undefined) await chrome.windows.update(t.windowId, { focused: true });
    await chrome.tabs.update(params.tabId, { active: true });
    return { success: true as const };
  } catch (e) {
    return { error: 'tab_closed', message: e instanceof Error ? e.message : String(e) };
  }
}
