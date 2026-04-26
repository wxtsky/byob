import { ScrollInput } from '@byob/shared';
import { tryAttachToTab } from '../cdp.js';
import {
  resolveFrame,
  evaluateInResolvedFrame,
  frameErrorToEnvelope,
} from '../frame-resolver.js';
import { openOrReuse } from '../tab.js';
import { checkUrlAllowed, urlForbiddenError } from '../url-guard.js';
import { throwIfAborted } from '../signal-utils.js';

export async function handleScroll(
  rawParams: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const params = ScrollInput.parse(rawParams);
  if (params.url) {
    const guard = checkUrlAllowed(params.url);
    if (!guard.ok) return urlForbiddenError(guard.reason);
  }
  throwIfAborted(signal);

  // openOrReuse: tabId given → use it (reused); url only → open a new background tab.
  // Interactive tools intentionally do NOT call cleanup — leaving the new tab open
  // lets the user (or downstream tools) act on the side effect.
  const tab = await openOrReuse({ url: params.url, tabId: params.tabId, signal });

  const { session, reason } = await tryAttachToTab(tab.tabId, signal);
  if (!session) return attachErrorToEnvelope(reason);

  let frame;
  try {
    frame = await resolveFrame(session, params.framePath, signal);
  } catch (e) {
    const env = frameErrorToEnvelope(e);
    if (env) return env;
    throw e;
  }

  // Build the script body. JSON.stringify safely embeds user inputs.
  const behavior = JSON.stringify(params.behavior);
  let scrollExpr: string;
  if (params.to === 'top') {
    scrollExpr = `window.scrollTo({ top: 0, behavior: ${behavior} })`;
  } else if (params.to === 'bottom') {
    scrollExpr = `window.scrollTo({ top: document.documentElement.scrollHeight, behavior: ${behavior} })`;
  } else if (params.selector !== undefined) {
    const sel = JSON.stringify(params.selector);
    scrollExpr = `(() => {
      const el = document.querySelector(${sel});
      if (!el) return { _err: 'selector_not_found' };
      el.scrollIntoView({ behavior: ${behavior}, block: 'start' });
      return { _ok: true };
    })()`;
  } else {
    scrollExpr = `window.scrollTo({ top: ${params.y!}, behavior: ${behavior} })`;
  }

  const expr = `(() => {
    const r = (${scrollExpr});
    if (r && r._err) return { error: r._err };
    return {
      scrollY: window.scrollY,
      pageHeight: document.documentElement.scrollHeight,
      url: location.href,
    };
  })()`;

  const result = await evaluateInResolvedFrame<
    { error?: string; scrollY?: number; pageHeight?: number; url?: string }
  >(session, frame, expr, { awaitPromise: false, returnByValue: true, signal });

  if (result.error === 'selector_not_found') {
    return { error: 'selector_not_found', message: `No element matched ${params.selector}` };
  }
  return {
    tabId: tab.tabId,
    url: result.url ?? '',
    scrollY: result.scrollY ?? 0,
    pageHeight: result.pageHeight ?? 0,
  };
}

function attachErrorToEnvelope(
  reason?: 'special_page' | 'tab_gone' | 'attach_failed',
): { error: string; message: string; hint?: string } {
  if (reason === 'special_page') {
    return {
      error: 'url_forbidden',
      message: 'Tab is on a special page (chrome://, devtools://, etc.) — CDP cannot attach.',
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
