import { throwIfAborted } from '../signal-utils.js';

export async function handleListTabs(
  _rawParams: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  throwIfAborted(signal);
  const tabs = await chrome.tabs.query({});
  return {
    tabs: tabs
      .filter((t) => t.id !== undefined)
      .map((t) => ({
        id: t.id!,
        url: t.url ?? '',
        title: t.title ?? '',
        active: !!t.active,
        windowId: t.windowId,
      })),
  };
}
