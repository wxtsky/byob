import { ClickInput } from '@byob/shared';
import { attachToTab } from '../cdp.js';

export async function handleClick(rawParams: unknown): Promise<unknown> {
  const params = ClickInput.parse(rawParams);

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

  const expr = `(() => {
    const el = document.querySelector(${JSON.stringify(params.selector)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.x + r.width / 2),
      y: Math.round(r.y + r.height / 2),
      text: (el.innerText || '').slice(0, 200),
    };
  })()`;
  const target = await session.evaluate<{ x: number; y: number; text: string } | null>(expr, {
    awaitPromise: false,
  });
  if (!target) {
    return { error: 'selector_not_found', message: `No element matched ${params.selector}` };
  }

  const modifierMask = (() => {
    let m = 0;
    if (params.modifiers.includes('Alt')) m |= 1;
    if (params.modifiers.includes('Control')) m |= 2;
    if (params.modifiers.includes('Meta')) m |= 4;
    if (params.modifiers.includes('Shift')) m |= 8;
    return m;
  })();

  const common = {
    x: target.x,
    y: target.y,
    button: params.button,
    clickCount: params.clickCount,
    modifiers: modifierMask,
  };
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...common });
  await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...common });
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...common });

  return { success: true as const, elementText: target.text };
}

async function activeTabId(): Promise<number | null> {
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return t?.id ?? null;
}
