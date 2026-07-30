import { SwitchTabInput } from '@byob/shared';
import { throwIfAborted } from '../signal-utils.js';
import { checkTabAccess } from '../tab-access.js';

export async function handleSwitchTab(
  rawParams: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const params = SwitchTabInput.parse(rawParams);
  throwIfAborted(signal);
  const access = await checkTabAccess(params.tabId, { allowForbiddenProtocol: true });
  if (!access.ok) return access.error;
  try {
    const t = access.tab;
    if (t.windowId !== undefined) await chrome.windows.update(t.windowId, { focused: true });
    await chrome.tabs.update(params.tabId, { active: true });
    return { success: true as const };
  } catch (e) {
    return { error: 'tab_closed', message: e instanceof Error ? e.message : String(e) };
  }
}
