import { WaitForInput } from '@byob/shared';
import { attachToTab } from '../cdp.js';

export async function handleWaitFor(rawParams: unknown): Promise<unknown> {
  const params = WaitForInput.parse(rawParams);

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

  const startedAt = Date.now();
  const expr = `(() => new Promise((resolve) => {
    const sel = ${JSON.stringify(params.selector)};
    const state = ${JSON.stringify(params.state)};
    const startedAt = performance.now();
    const isVisible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      const cs = getComputedStyle(el);
      return cs.visibility !== 'hidden' && cs.display !== 'none';
    };
    const matches = () => {
      const el = document.querySelector(sel);
      switch (state) {
        case 'attached': return !!el;
        case 'detached': return !el;
        case 'visible':  return isVisible(el);
        case 'hidden':   return !isVisible(el);
      }
      return false;
    };
    if (matches()) return resolve({ ok: true, elapsedMs: Math.round(performance.now() - startedAt) });
    const obs = new MutationObserver(() => {
      if (matches()) {
        obs.disconnect();
        clearTimeout(t);
        resolve({ ok: true, elapsedMs: Math.round(performance.now() - startedAt) });
      }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    const t = setTimeout(() => {
      obs.disconnect();
      resolve({ ok: false, elapsedMs: Math.round(performance.now() - startedAt) });
    }, ${params.timeoutSec * 1000});
  }))()`;
  const result = await session.evaluate<{ ok: boolean; elapsedMs: number }>(expr, {
    awaitPromise: true,
  });

  if (!result.ok) {
    return {
      error: 'timeout',
      message: `wait_for ${params.selector} (${params.state}) timed out after ${params.timeoutSec}s`,
      elapsedMs: result.elapsedMs,
    };
  }
  return { found: true as const, elapsedMs: Date.now() - startedAt };
}

async function activeTabId(): Promise<number | null> {
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return t?.id ?? null;
}
