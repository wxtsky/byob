import { GetHtmlInput } from '@byob/shared';
import { tryAttachToTab } from '../cdp.js';
import {
  resolveFrame,
  evaluateInResolvedFrame,
  frameErrorToEnvelope,
} from '../frame-resolver.js';
import { openOrReuse } from '../tab.js';
import { checkUrlAllowed, urlForbiddenError } from '../url-guard.js';
import { throwIfAborted } from '../signal-utils.js';
import { attachErrorEnvelope } from '../attach-error.js';
import { resolveByobIdxSelector } from './selector-resolver.js';

export async function handleGetHtml(
  rawParams: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const params = GetHtmlInput.parse(rawParams);
  const selector = resolveByobIdxSelector(params.selector);
  if (params.url) {
    const guard = checkUrlAllowed(params.url);
    if (!guard.ok) return urlForbiddenError(guard.reason);
  }
  throwIfAborted(signal);

  // get_html is read-only: cleanup the new tab if we opened it (matches
  // browser_read / browser_read_markdown / browser_extract_table).
  const tab = await openOrReuse({ url: params.url, tabId: params.tabId, signal });

  try {
    const { session, reason } = await tryAttachToTab(tab.tabId, signal);
    if (!session) return attachErrorEnvelope(reason);

    let frame;
    try {
      frame = await resolveFrame(session, params.framePath, signal);
    } catch (e) {
      const env = frameErrorToEnvelope(e);
      if (env) return env;
      throw e;
    }

    const sel = JSON.stringify(selector);
    const prop = params.outerHtml ? 'outerHTML' : 'innerHTML';
    const expr = `(() => {
      const el = document.querySelector(${sel});
      if (!el) return { error: 'selector_not_found' };
      return { html: el.${prop}, url: location.href };
    })()`;

    const result = await evaluateInResolvedFrame<
      { error?: string; html?: string; url?: string }
    >(session, frame, expr, { awaitPromise: false, returnByValue: true, signal });

    if (result.error === 'selector_not_found') {
      return { error: 'selector_not_found', message: `No element matched ${params.selector}` };
    }

    // Truncate at UTF-8 byte boundary so multi-byte characters never get split.
    const fullHtml = result.html ?? '';
    const fullBytes = new TextEncoder().encode(fullHtml).length;
    let html = fullHtml;
    let truncated = false;
    if (fullBytes > params.maxBytes) {
      html = truncateUtf8(fullHtml, params.maxBytes);
      truncated = true;
    }

    return {
      tabId: tab.tabId,
      url: result.url ?? '',
      html,
      byteLength: new TextEncoder().encode(html).length,
      truncated,
    };
  } finally {
    if (!tab.reused) await tab.cleanup();
  }
}

/**
 * Truncate `s` so its UTF-8 byte length is <= maxBytes, never cutting a
 * code point in half. We encode, slice, then decode back; the fatal:false
 * TextDecoder drops any incomplete trailing sequence.
 */
function truncateUtf8(s: string, maxBytes: number): string {
  const enc = new TextEncoder().encode(s);
  if (enc.byteLength <= maxBytes) return s;
  const slice = enc.slice(0, maxBytes);
  return new TextDecoder('utf-8', { fatal: false }).decode(slice);
}

