import { HandleJsDialogInput } from '@byob/shared';
import { getDialog, handleDialog } from '../dialog-registry.js';
import { throwIfAborted } from '../signal-utils.js';
import { checkTabAccess } from '../tab-access.js';

export async function handleHandleJsDialog(
  rawParams: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const params = HandleJsDialogInput.parse(rawParams);
  throwIfAborted(signal);
  const access = await checkTabAccess(params.tabId);
  if (!access.ok) return access.error;

  const dialog = getDialog(params.tabId);
  if (!dialog) {
    return {
      error: 'dialog_not_found',
      message: `No active JavaScript dialog in tab ${params.tabId}`,
      hint: 'Call browser_get_js_dialog immediately before handling the dialog.',
    };
  }
  if (params.text !== undefined && (params.action !== 'accept' || dialog.type !== 'prompt')) {
    return {
      error: 'invalid_dialog_action',
      message: 'text is only valid when accepting a prompt dialog',
    };
  }

  const handled = await handleDialog(params.tabId, params.action, params.text);
  if (!handled) {
    return {
      error: 'dialog_not_found',
      message: `The dialog in tab ${params.tabId} closed before it could be handled`,
    };
  }
  return { success: true as const, tabId: params.tabId, action: params.action };
}
