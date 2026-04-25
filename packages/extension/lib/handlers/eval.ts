import { EvalInput } from '@byob/shared';
import { tryAttachToTab } from '../cdp.js';
import { notifyEval, recordAndCheckRate } from '../notify.js';

export async function handleEval(rawParams: unknown): Promise<unknown> {
  const params = EvalInput.parse(rawParams);

  const tabId = params.tabId ?? (await activeTabId());
  if (tabId === null) return { error: 'unknown', message: 'No active tab' };

  if (!recordAndCheckRate(tabId)) {
    return {
      error: 'rate_limited',
      message: 'Too many eval calls in this tab in the last minute',
    };
  }

  const tab = await chrome.tabs.get(tabId);
  notifyEval(tabId, tab.url ?? '', params.code);

  const { session, reason } = await tryAttachToTab(tabId);
  if (!session) {
    if (reason === 'special_page') {
      return {
        error: 'url_forbidden',
        message: 'Active tab is on a special page (chrome://, devtools://, etc.) — CDP cannot attach.',
        hint: 'Switch to a regular http(s):// tab.',
      };
    }
    if (reason === 'tab_gone') return { error: 'tab_closed', message: 'Tab was closed.' };
    return {
      error: 'cdp_attach_failed',
      message: 'Could not attach Chrome debugger after 3 retries.',
      hint: 'Close DevTools (F12) on the target tab and retry.',
    };
  }

  const res = await session.send<{
    result: { value?: unknown; type: string };
    exceptionDetails?: unknown;
  }>('Runtime.evaluate', {
    expression: params.code,
    awaitPromise: params.awaitPromise,
    returnByValue: params.returnByValue,
  });
  if (res.exceptionDetails) {
    return {
      error: 'eval_exception',
      message: 'Page threw during eval',
      exceptionDetails: res.exceptionDetails,
    };
  }
  return { result: res.result?.value, resultType: res.result?.type ?? 'undefined' };
}

async function activeTabId(): Promise<number | null> {
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return t?.id ?? null;
}
