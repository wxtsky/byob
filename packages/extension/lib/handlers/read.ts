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
import { attach, pickTab, tabSummary } from './_common.js';

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

export async function handleRead(raw: unknown, signal: AbortSignal): Promise<unknown> {
  const p = Tools.ReadInput.parse(raw);
  let tabId: number;
  let opened = false;
  if (p.url) {
    const url = /^[a-z][a-z0-9+.-]*:/i.test(p.url) ? p.url : `https://${p.url}`;
    const g = checkUrlAllowed(url);
    if (!g.ok) {
      const env = urlForbiddenError(g.reason);
      throw new ByobError('url_forbidden', env.message, env.hint);
    }
    if (p.tabId !== undefined) {
      tabId = p.tabId;
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
  const session = await attach(tabId, signal, 'read');
  const el = hasTarget(p) ? await resolveTarget(session, p, signal) : null;
  const loc = el ? el.frame : await mainFrameLoc(session, signal);
  const budget = p.maxChars ?? (p.format === 'html' ? 60_000 : 20_000);

  keepAwakeStart();
  try {
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
