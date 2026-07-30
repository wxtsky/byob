import { throwIfAborted } from '../signal-utils.js';
import { checkHostPolicy } from '../url-guard.js';

export async function handleListTabs(
  _rawParams: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  throwIfAborted(signal);
  const all = await chrome.tabs.query({});
  const withIds = all.filter((t) => t.id !== undefined);
  // Enumerating tabs never attaches the debugger, so the policy check in
  // tryAttachToTab doesn't cover it — and a URL plus title is exactly the
  // kind of thing a deny list exists to keep out of the model's context.
  const visible = withIds.filter((t) => checkHostPolicy(t.url).ok);
  const hiddenByPolicy = withIds.length - visible.length;
  return {
    tabs: visible.map((t) => ({
      id: t.id!,
      url: t.url ?? '',
      title: t.title ?? '',
      active: !!t.active,
      windowId: t.windowId,
    })),
    ...(hiddenByPolicy > 0 ? { hiddenByPolicy } : {}),
  };
}
