import { GetJsDialogInput } from '@byob/shared';
import { attachErrorEnvelope } from '../attach-error.js';
import { tryAttachToTab } from '../cdp.js';
import { getDialog } from '../dialog-registry.js';
import { throwIfAborted } from '../signal-utils.js';
import { checkTabAccess } from '../tab-access.js';

export async function handleGetJsDialog(
  rawParams: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const params = GetJsDialogInput.parse(rawParams);
  throwIfAborted(signal);
  const access = await checkTabAccess(params.tabId);
  if (!access.ok) return access.error;

  // Page.enable is installed during attach. If a dialog is already open,
  // Chrome emits its opening state to the newly enabled Page domain.
  if (!getDialog(params.tabId)) {
    const attached = await tryAttachToTab(params.tabId, signal);
    if (!attached.session) return attachErrorEnvelope(attached);
    await Promise.resolve();
  }

  return {
    tabId: params.tabId,
    dialog: getDialog(params.tabId) ?? null,
  };
}
