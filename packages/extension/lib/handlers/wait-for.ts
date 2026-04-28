import { WaitForInput } from '@byob/shared';
import { tryAttachToTab } from '../cdp.js';
import {
  resolveFrame,
  evaluateInResolvedFrame,
  frameErrorToEnvelope,
} from '../frame-resolver.js';
import { abortPromise, throwIfAborted } from '../signal-utils.js';
import { resolveByobIdxSelector } from './selector-resolver.js';

export async function handleWaitFor(
  rawParams: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const params = WaitForInput.parse(rawParams);
  // Translate `byob:idx=N` → `[data-byob-idx="N"]` from the previous read.
  const selector = resolveByobIdxSelector(params.selector);

  const tabId = params.tabId ?? (await activeTabId());
  if (tabId === null) return { error: 'unknown', message: 'No active tab' };
  throwIfAborted(signal);

  const { session, reason } = await tryAttachToTab(tabId, signal);
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
    frame = await resolveFrame(session, params.framePath, signal);
  } catch (e) {
    const env = frameErrorToEnvelope(e);
    if (env) return env;
    throw e;
  }

  const startedAt = Date.now();
  const expr = `(() => new Promise((resolve) => {
    const sel = ${JSON.stringify(selector)};
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

  // The page-side promise can run for params.timeoutSec seconds; race against
  // the host signal so we cut the call short on abort even though chrome.debugger
  // has no native cancellation API for an in-flight Runtime.evaluate.
  const evalPromise = evaluateInResolvedFrame<{ ok: boolean; elapsedMs: number }>(
    session,
    frame,
    expr,
    { awaitPromise: true, returnByValue: true, signal },
  );
  const result = await Promise.race([evalPromise, abortPromise(signal)]);

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
