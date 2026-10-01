/** browser_read — page content as text / markdown / html / links / tables. */
import { Tools } from '@byob/shared';
import type { CdpSession } from '../cdp.js';
import { ByobError } from '../errors.js';
import { checkUrlAllowed, urlForbiddenError } from '../url-guard.js';
import { navigateAndWait, openAgentTab, waitFirstLoad } from '../tab.js';
import { callOnElement, hasTarget, mainFrameLoc, resolveTarget, type ElementHandle } from '../dom/element.js';
import { evaluateIsolated, type FrameLoc } from '../dom/frames.js';
import { EXTRACT_FN, HTML_FN, LAZY_SCROLL_FN, LINKS_FN, READABILITY_INSTALL } from '../extract.js';
import { keepAwakeEnd, keepAwakeStart } from '../keepalive.js';
import { offscreenRequest } from '../offscreen.js';
import { isAbortError, throwIfAborted } from '../signal-utils.js';
import { attach, pickTab, tabSummary } from './_common.js';

type ReadParams = ReturnType<typeof Tools.ReadInput.parse>;

/** Run `fn` with `this` = the target element, or the document of `loc`. */
async function runOn<T>(
  session: CdpSession,
  el: ElementHandle | null,
  loc: FrameLoc,
  fn: string,
  args: unknown[],
  signal: AbortSignal,
  awaitPromise = false,
): Promise<T> {
  if (el) return callOnElement<T>(el, fn, args, signal, { awaitPromise });
  const r = await evaluateIsolated<T>(session, loc,
    `(${fn}).call(document, ${args.map((a) => JSON.stringify(a)).join(', ')})`,
    { signal, awaitPromise });
  return r.value as T;
}

const HEADING = /^(#{1,6}) (.*)$/;

export function outlineOf(text: string): string {
  const out: string[] = [];
  for (const l of text.split('\n')) {
    const m = HEADING.exec(l);
    if (m) out.push(`${'  '.repeat(m[1]!.length - 1)}- ${m[2]}`);
  }
  return out.length ? out.join('\n') : '(no headings)';
}

/** Keep sections (heading + body) that mention `needle`; without headings,
 *  matching lines with one line of context. */
export function filterSections(text: string, needle: string): string {
  const n = needle.toLowerCase();
  const lines = text.split('\n');
  const sections: Array<{ path: string[]; lines: string[] }> = [];
  const path: string[] = [];
  let cur: { path: string[]; lines: string[] } = { path: [], lines: [] };
  for (const l of lines) {
    const m = HEADING.exec(l);
    if (m) {
      sections.push(cur);
      const level = m[1]!.length;
      path.length = level - 1;
      path[level - 1] = m[2]!;
      cur = { path: path.filter(Boolean), lines: [l] };
    } else cur.lines.push(l);
  }
  sections.push(cur);
  const hasHeadings = sections.length > 1;
  if (hasHeadings) {
    const hit = sections.filter((s) => s.lines.join('\n').toLowerCase().includes(n));
    if (!hit.length) return `(no section mentions "${needle}")`;
    return hit.map((s) => {
      const crumbs = s.path.length > 1 ? `[${s.path.slice(0, -1).join(' › ')}]\n` : '';
      return crumbs + s.lines.join('\n').trim();
    }).join('\n\n');
  }
  const keep = new Set<number>();
  lines.forEach((l, i) => {
    if (l.toLowerCase().includes(n)) [i - 1, i, i + 1].forEach((j) => j >= 0 && j < lines.length && keep.add(j));
  });
  if (!keep.size) return `(no line mentions "${needle}")`;
  return [...keep].sort((a, b) => a - b).map((i) => lines[i]).join('\n');
}

const DEFAULT_CHARS = 20_000;
const DEFAULT_HTML_CHARS = 60_000;

/**
 * Character budget for one page. With several URLs the default is split
 * between them (never below a useful floor); an explicit maxChars is per page.
 */
export function pageBudget(format: string, maxChars: number | undefined, pages = 1): number {
  if (maxChars !== undefined) return maxChars;
  const total = format === 'html' ? DEFAULT_HTML_CHARS : DEFAULT_CHARS;
  return pages > 1 ? Math.max(3_000, Math.floor(total / pages)) : total;
}

function withScheme(url: string): string {
  return /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
}

function assertAllowed(url: string): void {
  const g = checkUrlAllowed(url);
  if (!g.ok) {
    const env = urlForbiddenError(g.reason);
    throw new ByobError('url_forbidden', env.message, env.hint);
  }
}

// ---------------------------------------------------------------------------
// PDFs

/** Bigger files would take too long to move through CDP and messaging. */
const PDF_MAX_BYTES = 50 * 1024 * 1024;
const PDF_MAX_PAGES = 500;
/** Raw bytes per chunk moved page → service worker → offscreen document. */
const PDF_CHUNK = 4 * 1024 * 1024;

/**
 * Fetch the open PDF again inside the page — same origin, so the page's
 * cookies apply and logged-in documents work — and park the bytes in the
 * isolated world for chunked reads.
 */
const PDF_FETCH = `(async () => {
  const r = await fetch(location.href, { credentials: 'include' });
  if (!r.ok) return { error: 'HTTP ' + r.status };
  const declared = Number(r.headers.get('content-length') || 0);
  if (declared > ${PDF_MAX_BYTES}) return { tooLarge: declared };
  const bytes = new Uint8Array(await r.arrayBuffer());
  if (bytes.length > ${PDF_MAX_BYTES}) return { tooLarge: bytes.length };
  globalThis.__byobPdf = bytes;
  return { size: bytes.length };
})()`;

const pdfChunk = (offset: number): string => `(() => {
  const part = globalThis.__byobPdf.subarray(${offset}, ${offset + PDF_CHUNK});
  let s = '';
  for (let i = 0; i < part.length; i += 0x8000) s += String.fromCharCode.apply(null, part.subarray(i, i + 0x8000));
  return btoa(s);
})()`;

/** Pages → one text with page markers; `outline` and `filter` work per page. */
export function pdfToText(pages: string[], opts: { outline?: boolean; filter?: string } = {}): string {
  if (opts.outline) {
    return pages.map((t, i) => `- page ${i + 1}: ${(t.split('\n').find((l) => l.trim()) ?? '(empty)').trim().slice(0, 120)}`).join('\n');
  }
  const parts: string[] = [];
  pages.forEach((t, i) => {
    if (opts.filter) {
      if (!t.toLowerCase().includes(opts.filter.toLowerCase())) return;
      t = filterSections(t, opts.filter);
    }
    parts.push(`--- page ${i + 1} ---\n${t}`);
  });
  if (opts.filter && !parts.length) return `(no page mentions "${opts.filter}")`;
  return parts.join('\n\n');
}

interface PdfRead {
  text: string;
  truncated: boolean;
  totalChars: number;
  pdfPages: number;
  note?: string;
}

async function readPdf(session: CdpSession, loc: FrameLoc, p: ReadParams, budget: number, signal: AbortSignal): Promise<PdfRead> {
  const got = await evaluateIsolated<{ size?: number; error?: string; tooLarge?: number }>(session, loc, PDF_FETCH, { signal, awaitPromise: true });
  const head = got.value ?? {};
  if (head.error) throw new ByobError('unknown', `Couldn't fetch the PDF again to read it: ${head.error}.`, 'Try browser_screenshot, or download it.');
  if (head.tooLarge !== undefined) {
    throw new ByobError('invalid_argument', `The PDF is ${(head.tooLarge / 1024 / 1024).toFixed(1)} MB; byob reads up to ${PDF_MAX_BYTES / 1024 / 1024} MB.`);
  }
  const size = head.size ?? 0;
  const id = crypto.randomUUID();
  try {
    await offscreenRequest({ action: 'pdf-start', id, size });
    for (let offset = 0; offset < size; offset += PDF_CHUNK) {
      throwIfAborted(signal);
      const data = (await evaluateIsolated<string>(session, loc, pdfChunk(offset), { signal })).value ?? '';
      const r = await offscreenRequest<{ ok: boolean; error?: string }>({ action: 'pdf-chunk', id, offset, data });
      if (!r?.ok) throw new ByobError('unknown', `PDF transfer failed: ${r?.error ?? 'no answer'}`);
    }
    // Outline and filter need every page; otherwise stop once over budget.
    const wantAll = p.outline || p.filter;
    const r = await offscreenRequest<{ ok: boolean; error?: string; numPages?: number; pages?: string[] }>({
      action: 'pdf-text', id, maxPages: PDF_MAX_PAGES, maxChars: wantAll ? 2_000_000 : budget,
    });
    if (!r?.ok) throw new ByobError('unknown', `Couldn't read the PDF: ${r?.error ?? 'no answer'}`);
    const pages = r.pages ?? [];
    const numPages = r.numPages ?? pages.length;
    const notes: string[] = [];
    if (!pages.some((t) => t.trim())) notes.push('no text layer (a scanned PDF?) — try browser_screenshot');
    if (numPages > pages.length) notes.push(`read the first ${pages.length} of ${numPages} pages`);
    let text = pdfToText(pages, { outline: p.outline, filter: p.filter });
    const totalChars = text.length;
    const truncated = text.length > budget || numPages > pages.length;
    if (text.length > budget) text = text.slice(0, budget);
    return { text, truncated, totalChars, pdfPages: numPages, ...(notes.length ? { note: notes.join('; ') } : {}) };
  } finally {
    await offscreenRequest({ action: 'pdf-free', id }).catch(() => {});
    await evaluateIsolated(session, loc, 'delete globalThis.__byobPdf', {}).catch(() => {});
  }
}

// ---------------------------------------------------------------------------

/** Read one tab that's already showing the page. */
async function readTab(tabId: number, p: ReadParams, budget: number, opened: boolean, signal: AbortSignal): Promise<Record<string, unknown>> {
  const session = await attach(tabId, signal, 'read');
  const el = hasTarget(p) ? await resolveTarget(session, p, signal) : null;
  const loc = el ? el.frame : await mainFrameLoc(session, signal);

  keepAwakeStart();
  try {
    if (!el) {
      // Chrome's PDF viewer: the DOM is just an <embed>, the text is in the file.
      const isPdf = (await evaluateIsolated<boolean>(session, loc, `document.contentType === 'application/pdf'`, { signal })).value;
      if (isPdf) {
        const info = await tabSummary(tabId);
        const r = await readPdf(session, loc, p, budget, signal);
        return { ...info, format: p.format === 'html' || p.format === 'links' || p.format === 'tables' ? 'text' : p.format, opened, source: 'pdf', ...r };
      }
    }
    if (p.scroll) await runOn(session, null, loc, LAZY_SCROLL_FN, [12], signal, true);
    const info = await tabSummary(tabId);
    const base = { ...info, format: p.format, opened };

    if (p.format === 'links') {
      const links = await runOn<Array<{ text: string; url: string }>>(session, el, loc, LINKS_FN, [800], signal);
      return { ...base, links, count: links.length };
    }
    if (p.format === 'html') {
      const r = await runOn<{ html: string; truncated: boolean; length: number }>(session, el, loc, HTML_FN, [budget], signal);
      return { ...base, text: r.html, truncated: r.truncated, totalChars: r.length };
    }
    const useReadability = p.format === 'markdown' && !el && !p.filter;
    if (useReadability) {
      await evaluateIsolated(session, loc, READABILITY_INSTALL, { signal }).catch(() => {});
    }
    // Outline and filter read the whole document, then cut it down here.
    const walkBudget = p.outline || p.filter ? Math.max(budget, 400_000) : budget;
    const r = await runOn<{ text: string; title: string; truncated: boolean; source: string }>(
      session, el, loc, EXTRACT_FN, [p.format, walkBudget, useReadability], signal,
    );
    let text = r.text;
    if (p.outline) text = outlineOf(text);
    else if (p.filter) text = filterSections(text, p.filter);
    const truncated = text.length > budget || (!p.outline && !p.filter && r.truncated);
    if (text.length > budget) text = text.slice(0, budget);
    return {
      ...base,
      text,
      truncated,
      source: el ? 'element' : r.source,
      totalChars: r.text.length,
    };
  } finally {
    keepAwakeEnd();
  }
}

const MAX_URLS = 10;
/** How many pages of a `urls` read load at once. */
const PARALLEL = 4;
const PAGE_LOAD_MS = 30_000;

/**
 * browser_read {urls}: each page in its own background tab (byob group),
 * a few at a time, closed afterwards whatever happens. A page that fails
 * reports its error in its own entry.
 */
async function readMany(p: ReadParams, signal: AbortSignal): Promise<unknown> {
  const urls = p.urls!.map(withScheme);
  const budget = pageBudget(p.format, p.maxChars, urls.length);
  // Opened one after another: concurrent openAgentTab calls would each
  // create their own "byob" tab group.
  let opening: Promise<unknown> = Promise.resolve();
  const open = (url: string): Promise<number> => {
    const t = opening.then(() => openAgentTab(url));
    opening = t.catch(() => undefined);
    return t;
  };

  const readOne = async (url: string): Promise<Record<string, unknown>> => {
    let tabId: number | undefined;
    try {
      assertAllowed(url);
      throwIfAborted(signal);
      tabId = await open(url);
      await waitFirstLoad(tabId, PAGE_LOAD_MS, signal).catch((e) => {
        if (isAbortError(e)) throw e;
      });
      const r = await readTab(tabId, p, budget, true, signal);
      const { tabId: _t, opened: _o, ...page } = r;
      void _t;
      void _o;
      return { ...page, url: (r.url as string) || url, requested: url };
    } catch (e) {
      if (isAbortError(e)) throw e;
      const code = e instanceof ByobError ? `${e.code}: ` : '';
      return { url, requested: url, error: `${code}${e instanceof Error ? e.message : String(e)}` };
    } finally {
      if (tabId !== undefined) await chrome.tabs.remove(tabId).catch(() => {});
    }
  };

  const pages: Array<Record<string, unknown>> = new Array(urls.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < urls.length) {
      const i = next++;
      pages[i] = await readOne(urls[i]!);
    }
  };
  // allSettled: an abort in one worker must not return before the others
  // have closed their tabs.
  const settled = await Promise.allSettled(Array.from({ length: Math.min(PARALLEL, urls.length) }, worker));
  const failed = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
  if (failed) throw failed.reason;
  return { format: p.format, pages, perPageChars: budget };
}

export async function handleRead(raw: unknown, signal: AbortSignal): Promise<unknown> {
  const p = Tools.ReadInput.parse(raw);
  if (p.urls?.length) {
    // Checked here rather than in the schema: every schema character is
    // paid for in the agent's context on every turn.
    if (p.urls.length > MAX_URLS) throw new ByobError('invalid_argument', `browser_read: at most ${MAX_URLS} urls per call.`);
    if (p.url) throw new ByobError('invalid_argument', 'browser_read: pass url or urls, not both.');
    if (hasTarget(p)) throw new ByobError('invalid_argument', 'browser_read: ref/selector/framePath only apply to a single page, not urls.');
    return readMany(p, signal);
  }
  let tabId: number;
  let opened = false;
  if (p.url) {
    const url = withScheme(p.url);
    assertAllowed(url);
    if (p.tabId !== undefined) {
      // Same access check as any other tabId: never navigate a tab the
      // user's site policy puts off limits.
      tabId = await pickTab(p);
      await navigateAndWait(tabId, url, 45_000, signal).catch((e) => {
        if ((e as { name?: string }).name === 'AbortError') throw e;
      });
    } else {
      tabId = await openAgentTab(url);
      opened = true;
      await waitFirstLoad(tabId, 45_000, signal).catch((e) => {
        if ((e as { name?: string }).name === 'AbortError') throw e;
      });
    }
  } else {
    tabId = await pickTab(p);
  }
  return readTab(tabId, p, pageBudget(p.format, p.maxChars), opened, signal);
}
