/**
 * browser_fetch — call a URL with the browser's login state and get the reply
 * back as data, without opening or touching a page.
 *
 * from:"page" (default) runs fetch() in byob's isolated world of the tab, so
 * the request carries the page's origin, cookies and CSRF headers exactly as
 * the site's own scripts would — and the page can't have swapped out fetch.
 * Same-origin rules apply, as they do for the page.
 *
 * from:"extension" fetches from byob's service worker instead: any site, no
 * CORS, the browser's cookies for that site included. No tab needed.
 */
import { Tools } from '@byob/shared';
import { ByobError } from '../errors.js';
import { mainFrameLoc } from '../dom/element.js';
import { evaluateIsolated } from '../dom/frames.js';
import { checkUrlAllowed, urlForbiddenError } from '../url-guard.js';
import { attach, pickTab, tabSummary } from './_common.js';

export interface FetchResult {
  tabId?: number;
  from: 'page' | 'extension';
  status: number;
  statusText: string;
  url: string;
  redirected: boolean;
  headers: Record<string, string>;
  body: string;
  encoding: 'utf8' | 'base64';
  bytes: number;
  truncated: boolean;
}

/** Runs in the page (as source text) and in the service worker (as is). */
const FETCH_BODY = `
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
  try {
    const r = await fetch(opts.url, {
      method: opts.method, headers: opts.headers, body: opts.body,
      credentials: 'include', redirect: 'follow', signal: ctrl.signal,
    });
    const headers = {};
    r.headers.forEach((v, k) => { headers[k] = v; });
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    const textual = !ct || /json|text|xml|javascript|html|x-www-form-urlencoded|csv|svg|graphql/.test(ct);
    const buf = new Uint8Array(await r.arrayBuffer());
    const cap = Math.min(buf.length, opts.maxBytes);
    let body = '', encoding = 'utf8';
    if (textual) body = new TextDecoder().decode(buf.subarray(0, cap));
    else {
      let s = '';
      for (let i = 0; i < cap; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, Math.min(cap, i + 0x8000)));
      body = btoa(s); encoding = 'base64';
    }
    return { status: r.status, statusText: r.statusText, url: r.url, redirected: r.redirected, headers, body, encoding, bytes: buf.length, truncated: buf.length > cap };
  } catch (e) {
    return { error: e && e.name === 'AbortError' ? 'timed out after ' + opts.timeoutMs + ' ms' : String(e && e.message || e) };
  } finally {
    clearTimeout(timer);
  }
`;

type FetchOpts = { url: string; method: string; headers?: Record<string, string>; body?: string; timeoutMs: number; maxBytes: number };
type Raw = Omit<FetchResult, 'tabId' | 'from'> | { error: string };

/**
 * The service-worker twin of FETCH_BODY. It can't reuse the string: MV3
 * forbids eval/new Function in extension pages, and fn.toString() into the
 * page breaks under minification. Keep the two in step.
 */
async function fetchInWorker(opts: FetchOpts): Promise<Raw> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
  try {
    const r = await fetch(opts.url, {
      method: opts.method, headers: opts.headers, body: opts.body,
      credentials: 'include', redirect: 'follow', signal: ctrl.signal,
    });
    const headers: Record<string, string> = {};
    r.headers.forEach((v, k) => { headers[k] = v; });
    const ct = (r.headers.get('content-type') ?? '').toLowerCase();
    const textual = !ct || /json|text|xml|javascript|html|x-www-form-urlencoded|csv|svg|graphql/.test(ct);
    const buf = new Uint8Array(await r.arrayBuffer());
    const cap = Math.min(buf.length, opts.maxBytes);
    let body = '';
    let encoding: 'utf8' | 'base64' = 'utf8';
    if (textual) body = new TextDecoder().decode(buf.subarray(0, cap));
    else {
      let s = '';
      for (let i = 0; i < cap; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, Math.min(cap, i + 0x8000)));
      body = btoa(s);
      encoding = 'base64';
    }
    return { status: r.status, statusText: r.statusText, url: r.url, redirected: r.redirected, headers, body, encoding, bytes: buf.length, truncated: buf.length > cap };
  } catch (e) {
    const err = e as Error;
    return { error: err?.name === 'AbortError' ? `timed out after ${opts.timeoutMs} ms` : String(err?.message ?? e) };
  } finally {
    clearTimeout(timer);
  }
}

export async function handleFetch(raw: unknown, signal: AbortSignal): Promise<FetchResult> {
  const p = Tools.FetchInput.parse(raw);
  const opts: Omit<FetchOpts, 'url'> = {
    method: p.method.toUpperCase(),
    headers: p.headers,
    body: p.body,
    timeoutMs: p.timeoutSec * 1000,
    // Saved bodies may be big; ones read inline are capped by the MCP side anyway.
    maxBytes: p.savePath ? 50 * 1024 * 1024 : Math.max(p.maxChars * 4, 64 * 1024),
  };

  let res: Raw;
  let tabId: number | undefined;
  if (p.from === 'extension') {
    if (!/^https?:\/\//i.test(p.url)) throw new ByobError('invalid_argument', 'from:"extension" needs an absolute http(s) URL.');
    const g = checkUrlAllowed(p.url);
    if (!g.ok) { const e = urlForbiddenError(g.reason); throw new ByobError(e.error, e.message, e.hint); }
    res = await fetchInWorker({ ...opts, url: p.url });
  } else {
    tabId = await pickTab(p);
    const base = (await tabSummary(tabId)).url;
    let url: string;
    try { url = new URL(p.url, base).href; } catch { throw new ByobError('invalid_argument', `Bad URL: ${p.url}`); }
    const g = checkUrlAllowed(url);
    if (!g.ok) { const e = urlForbiddenError(g.reason); throw new ByobError(e.error, e.message, e.hint); }
    const session = await attach(tabId, signal, 'fetch');
    const loc = await mainFrameLoc(session, signal);
    const expr = `(async (opts) => {${FETCH_BODY}})(${JSON.stringify({ ...opts, url })})`;
    res = (await evaluateIsolated<Raw>(session, loc, expr, { awaitPromise: true, signal })).value ?? { error: 'no result' };
  }
  if ('error' in res) {
    const cors = p.from === 'page' && /Failed to fetch/i.test(res.error);
    throw new ByobError('unknown', `fetch failed: ${res.error}`, cors ? 'Cross-origin from the page is subject to CORS; retry with from:"extension".' : undefined);
  }
  return { ...(tabId !== undefined ? { tabId } : {}), from: p.from, ...res };
}
