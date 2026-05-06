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
  // Per-call token lets host-side abort tear down the page-side observer
  // and timer instead of letting them run for the full timeoutSec. Without
  // this, aborting wait_for on a busy DOM (Twitter, Discord) keeps the
  // MutationObserver firing on every mutation until timeoutSec elapses.
  const abortToken = crypto.randomUUID();
  const expr = `(() => new Promise((resolve) => {
    const sel = ${JSON.stringify(selector)};
    const state = ${JSON.stringify(params.state)};
    const token = ${JSON.stringify(abortToken)};
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
    const reg = (globalThis.__byob_waitfor ||= new Map());
    const cleanup = (result) => {
      try { obs.disconnect(); } catch {}
      try { clearTimeout(t); } catch {}
      reg.delete(token);
      resolve(result);
    };
    if (matches()) return resolve({ ok: true, elapsedMs: Math.round(performance.now() - startedAt) });
    const obs = new MutationObserver(() => {
      if (matches()) cleanup({ ok: true, elapsedMs: Math.round(performance.now() - startedAt) });
    });
    obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    const t = setTimeout(() => {
      cleanup({ ok: false, elapsedMs: Math.round(performance.now() - startedAt) });
    }, ${params.timeoutSec * 1000});
    reg.set(token, () => cleanup({ ok: false, aborted: true, elapsedMs: Math.round(performance.now() - startedAt) }));
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
  // Best-effort page-side teardown when the host signal aborts: fire a
  // cleanup eval that grabs the registered cleanup() and runs it. Errors
  // are swallowed — the only purpose is to free the observer/timer.
  const onAbort = (): void => {
    void evaluateInResolvedFrame(
      session,
      frame,
      `(() => { const reg = globalThis.__byob_waitfor; const fn = reg && reg.get(${JSON.stringify(abortToken)}); if (fn) fn(); })()`,
      { awaitPromise: false, returnByValue: true },
    ).catch(() => {});
  };
  signal.addEventListener('abort', onAbort, { once: true });
  let result: { ok: boolean; elapsedMs: number };
  try {
    result = await Promise.race([evalPromise, abortPromise(signal)]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }

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
