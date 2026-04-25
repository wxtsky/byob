import { TypeInput } from '@byob/shared';
import { attachToTab } from '../cdp.js';

export async function handleType(rawParams: unknown): Promise<unknown> {
  const params = TypeInput.parse(rawParams);

  const tabId = params.tabId ?? (await activeTabId());
  if (tabId === null) return { error: 'unknown', message: 'No active tab' };

  const session = await attachToTab(tabId);
  if (!session) {
    return {
      error: 'cdp_attach_failed',
      message: 'Could not attach Chrome debugger.',
      hint: 'Close DevTools (F12) on the target tab and retry.',
    };
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
  const ok = await session.evaluate<boolean>(focusExpr, { awaitPromise: false });
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
