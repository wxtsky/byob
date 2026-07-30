/**
 * Registry for JavaScript dialogs observed through the CDP Page domain.
 *
 * A previous implementation auto-accepted confirm/beforeunload dialogs.
 * That made destructive site actions possible without the agent or user
 * seeing the final confirmation. Dialogs are now inert until an explicit
 * browser_handle_js_dialog call accepts or dismisses them.
 */

export type JsDialogType = 'alert' | 'confirm' | 'prompt' | 'beforeunload';

export interface JsDialog {
  type: JsDialogType;
  message: string;
  url?: string;
  defaultPrompt?: string;
  openedAt: number;
}

interface DialogOpeningParams {
  type?: JsDialogType;
  message?: string;
  url?: string;
  defaultPrompt?: string;
}

const dialogs = new Map<number, JsDialog>();

export function recordDialogOpening(
  tabId: number,
  params: DialogOpeningParams,
): JsDialog {
  const dialog: JsDialog = {
    type: params.type ?? 'alert',
    message: params.message ?? '',
    openedAt: Date.now(),
  };
  if (params.url !== undefined) dialog.url = params.url;
  if (params.defaultPrompt !== undefined) dialog.defaultPrompt = params.defaultPrompt;
  dialogs.set(tabId, dialog);
  return dialog;
}

export function recordDialogClosed(tabId: number): void {
  dialogs.delete(tabId);
}

export function getDialog(tabId: number): JsDialog | undefined {
  const dialog = dialogs.get(tabId);
  return dialog ? { ...dialog } : undefined;
}

export async function handleDialog(
  tabId: number,
  action: 'accept' | 'dismiss',
  text?: string,
): Promise<boolean> {
  if (!dialogs.has(tabId)) return false;
  const params: Record<string, unknown> = { accept: action === 'accept' };
  if (action === 'accept' && text !== undefined) params.promptText = text;
  await chrome.debugger.sendCommand(
    { tabId },
    'Page.handleJavaScriptDialog',
    params,
  );
  dialogs.delete(tabId);
  return true;
}

function onDebuggerDialogEvent(
  source: chrome.debugger.Debuggee,
  method: string,
  params?: object,
): void {
  if (source.tabId === undefined) return;
  if (method === 'Page.javascriptDialogOpening') {
    recordDialogOpening(source.tabId, (params ?? {}) as DialogOpeningParams);
  } else if (method === 'Page.javascriptDialogClosed') {
    recordDialogClosed(source.tabId);
  }
}

function onTabRemoved(tabId: number): void {
  recordDialogClosed(tabId);
}

function onDebuggerDetach(source: chrome.debugger.Debuggee): void {
  if (source.tabId !== undefined) recordDialogClosed(source.tabId);
}

export function startDialogRegistry(): void {
  if (!chrome.debugger.onEvent.hasListener?.(onDebuggerDialogEvent)) {
    chrome.debugger.onEvent.addListener(onDebuggerDialogEvent);
  }
  if (!chrome.debugger.onDetach.hasListener?.(onDebuggerDetach)) {
    chrome.debugger.onDetach.addListener(onDebuggerDetach);
  }
  if (!chrome.tabs.onRemoved.hasListener?.(onTabRemoved)) {
    chrome.tabs.onRemoved.addListener(onTabRemoved);
  }
}

/** Test-only reset; harmless but intentionally not used by production code. */
export function clearDialogRegistryForTest(): void {
  dialogs.clear();
}
