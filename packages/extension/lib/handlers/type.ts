import { TypeInput } from '@byob/shared';
import { tryAttachToTab } from '../cdp.js';
import { attachErrorEnvelope } from '../attach-error.js';
import {
  resolveFrame,
  evaluateInResolvedFrame,
  frameErrorToEnvelope,
} from '../frame-resolver.js';
import { throwIfAborted } from '../signal-utils.js';
import { resolveByobIdxSelector } from './selector-resolver.js';

export async function handleType(
  rawParams: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const params = TypeInput.parse(rawParams);
  // Translate `byob:idx=N` → `[data-byob-idx="N"]`. The data-byob-idx attr
  // is set by the in-page collector during browser_read (see
  // clickable-detector.ts). Indices invalidate on SPA re-render or
  // navigation — re-run browser_read to refresh.
  const selector =
    params.selector === undefined ? undefined : resolveByobIdxSelector(params.selector);

  const tabId = params.tabId ?? (await activeTabId());
  if (tabId === null) return { error: 'unknown', message: 'No active tab' };
  throwIfAborted(signal);

  const attachResult = await tryAttachToTab(tabId, signal);
  const { session } = attachResult;
  if (!session) {
    return attachErrorEnvelope(attachResult);
  }

  let frame;
  try {
    frame = await resolveFrame(session, params.framePath, signal);
  } catch (e) {
    const env = frameErrorToEnvelope(e);
    if (env) return env;
    throw e;
  }

  const targetExpr =
    selector === undefined
      ? 'document.activeElement'
      : `document.querySelector(${JSON.stringify(selector)})`;
  const focusExpr = `(() => {
    const el = ${targetExpr};
    if (!el) return false;
    if (${selector === undefined ? 'false' : 'true'}) {
      el.scrollIntoView({ block: 'center' });
      el.focus();
    }
    if (el === document.body || el === document.documentElement) return false;
    if (${params.clear ? 'true' : 'false'}) {
      if ('value' in el) el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return true;
  })()`;
  const ok = await evaluateInResolvedFrame<boolean>(session, frame, focusExpr, {
    awaitPromise: false,
    signal,
  });
  if (!ok) {
    return selector === undefined
      ? {
          error: 'element_not_focused',
          message: 'No editable element is currently focused. Click a field before typing.',
        }
      : { error: 'selector_not_found', message: `No element matched ${params.selector}` };
  }

  await session.send('Input.insertText', { text: params.text }, signal);

  if (params.pressEnter) {
    const keyParams = {
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    };
    await session.send('Input.dispatchKeyEvent', { type: 'keyDown', ...keyParams }, signal);
    await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...keyParams }, signal);
  }

  return { success: true as const };
}

async function activeTabId(): Promise<number | null> {
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return t?.id ?? null;
}
