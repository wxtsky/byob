import { TypeInput } from '@byob/shared';
import { tryAttachToTab } from '../cdp.js';
import {
  resolveFrame,
  evaluateInResolvedFrame,
  frameErrorToEnvelope,
} from '../frame-resolver.js';

export async function handleType(rawParams: unknown): Promise<unknown> {
  const params = TypeInput.parse(rawParams);

  const tabId = params.tabId ?? (await activeTabId());
  if (tabId === null) return { error: 'unknown', message: 'No active tab' };

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

  let frame;
  try {
    frame = await resolveFrame(session, params.framePath);
  } catch (e) {
    const env = frameErrorToEnvelope(e);
    if (env) return env;
    throw e;
  }

  const focusExpr = `(() => {
    const el = document.querySelector(${JSON.stringify(params.selector)});
    if (!el) return false;
    el.scrollIntoView({ block: 'center' });
    el.focus();
    if (${params.clear ? 'true' : 'false'}) {
      if ('value' in el) el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return true;
  })()`;
  const ok = await evaluateInResolvedFrame<boolean>(session, frame, focusExpr, {
    awaitPromise: false,
  });
  if (!ok) {
    return { error: 'selector_not_found', message: `No element matched ${params.selector}` };
  }

  await session.send('Input.insertText', { text: params.text });

  if (params.pressEnter) {
    const keyParams = {
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    };
    await session.send('Input.dispatchKeyEvent', { type: 'keyDown', ...keyParams });
    await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...keyParams });
  }

  return { success: true as const };
}

async function activeTabId(): Promise<number | null> {
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return t?.id ?? null;
}
