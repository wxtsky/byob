/**
 * Page content extraction, run inside byob's isolated world.
 *
 * One DOM walker produces both "text" (plain, with `#` heading markers kept
 * so outline/filter work) and "markdown" (links, images, GFM tables, code
 * fences). It honours visibility, walks open shadow roots, skips
 * script/style/svg, and stops at a character budget instead of serialising
 * a whole 5 MB page across the debugger pipe.
 *
 * "markdown" first asks Mozilla Readability (bundled, evaluated into the
 * same isolated world) for the main article, falling back to the whole body.
 */
// Vite inlines the library source; it is evaluated into the isolated world
// on first use rather than executed in the service worker.
import READABILITY_SRC from '@mozilla/readability/Readability.js?raw';
import { SENSITIVE_PREDICATE_SRC } from './sensitive.js';

export const READABILITY_INSTALL = `(() => {
  if (globalThis.__byobReadability) return true;
  ${READABILITY_SRC}
  globalThis.__byobReadability = Readability;
  return true;
})()`;

/**
 * `this` = root element (or document). Args: mode, budget, useReadability.
 * Returns { text, title, truncated, source }.
 */
export const EXTRACT_FN = `function (mode, budget, useReadability) {
  const tablesOnly = mode === 'tables';
  const md = mode === 'markdown' || tablesOnly;
  ${SENSITIVE_PREDICATE_SRC}
  let tableNo = 0;
  let root = this && this.nodeType === 9 ? (this.body || this.documentElement) : this;
  let source = 'page';
  if (md && useReadability && globalThis.__byobReadability) {
    try {
      const art = new globalThis.__byobReadability(document.cloneNode(true), { charThreshold: 300 }).parse();
      if (art && art.content && (art.textContent || '').trim().length > 200) {
        const holder = document.createElement('div');
        holder.innerHTML = art.content;
        root = holder;
        source = 'article';
      }
    } catch (e) { /* fall back to the full page */ }
  }
  const detached = !root.isConnected;
  const SKIP = new Set(['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','SVG','CANVAS','IFRAME','OBJECT','EMBED','HEAD','META','LINK']);
  const BLOCK = new Set(['P','DIV','SECTION','ARTICLE','MAIN','ASIDE','HEADER','FOOTER','NAV','FORM','FIELDSET','FIGURE','FIGCAPTION','DETAILS','SUMMARY','ADDRESS','DL','DT','DD','CENTER']);
  const out = [];
  let size = 0;
  let truncated = false;
  const emit = (s) => {
    if (truncated) return;
    out.push(s);
    size += s.length;
    if (size > budget) truncated = true;
  };
  let line = '';
  let indent = '';
  const flush = () => {
    const t = line.replace(/\\s+/g, ' ').trim();
    if (t) emit(indent + t);
    line = '';
    indent = '';
  };
  // Markdown needs blank lines around headings, tables and fences to render.
  const gap = () => { if (md && !tablesOnly && out.length && out[out.length - 1] !== '') out.push(''); };
  const block = (fn) => { flush(); fn(); flush(); };
  const visible = (el) => {
    if (detached) return el.hidden !== true && el.getAttribute('aria-hidden') !== 'true';
    if (typeof el.checkVisibility === 'function') return el.checkVisibility({ visibilityProperty: true, opacityProperty: false });
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden';
  };
  const abs = (u) => { try { return new URL(u, document.baseURI).href; } catch (e) { return u; } };
  const inlineText = (el) => (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
  const cellText = (c) => inlineText(c).replace(/\\|/g, '\\\\|');

  const table = (t) => {
    const rows = Array.from(t.rows || []).slice(0, 300);
    if (!rows.length) return;
    const grid = rows.map((r) => Array.from(r.cells).map(cellText));
    const width = Math.max(...grid.map((r) => r.length));
    if (width === 0) return;
    flush();
    gap();
    const cap = t.caption ? inlineText(t.caption) : '';
    tableNo++;
    if (tablesOnly) emit((tableNo > 1 ? '\\n' : '') + 'Table ' + tableNo + (cap ? ': ' + cap : ''));
    else if (cap) emit(md ? '**' + cap + '**' : cap);
    if (md) {
      const pad = (r) => { const x = r.slice(); while (x.length < width) x.push(''); return x; };
      emit('| ' + pad(grid[0]).join(' | ') + ' |');
      emit('|' + ' --- |'.repeat(width));
      for (const r of grid.slice(1)) emit('| ' + pad(r).join(' | ') + ' |');
    } else {
      for (const r of grid) emit(r.join('\\t'));
    }
    if ((t.rows || []).length > 300) emit('… (' + (t.rows.length - 300) + ' more rows)');
  };

  const list = (el, depth) => {
    let i = 0;
    for (const li of el.children) {
      if (li.tagName !== 'LI' || !visible(li)) continue;
      i++;
      flush();
      indent = '  '.repeat(depth);
      line = el.tagName === 'OL' ? i + '. ' : '- ';
      const mark = indent;
      walkChildren(li, depth + 1);
      indent = indent || mark;
      flush();
    }
  };

  const walkChildren = (el, depth) => {
    const kids = el.shadowRoot ? [...el.shadowRoot.childNodes, ...el.childNodes] : el.childNodes;
    for (const n of kids) walk(n, depth);
  };

  const walk = (n, depth) => {
    if (truncated) return;
    if (n.nodeType === 3) {
      if (!tablesOnly) line += n.nodeValue;
      return;
    }
    if (n.nodeType !== 1) return;
    const el = n;
    const tag = el.tagName;
    if (SKIP.has(tag.toUpperCase())) return;
    if (!visible(el)) return;
    if (tablesOnly && tag !== 'TABLE') { walkChildren(el, depth); return; }
    if (/^H[1-6]$/.test(tag)) {
      const t = inlineText(el);
      if (t) block(() => { gap(); emit('#'.repeat(+tag[1]) + ' ' + t); });
      return;
    }
    switch (tag) {
      case 'BR': flush(); return;
      case 'HR': block(() => emit('---')); return;
      case 'UL': case 'OL': flush(); list(el, depth); flush(); return;
      case 'TABLE': table(el); return;
      case 'PRE': {
        const code = el.innerText || el.textContent || '';
        block(() => emit(md ? (gap(), '\\u0060\\u0060\\u0060\\n') + code.replace(/\\n+$/, '') + '\\n\\u0060\\u0060\\u0060' : code));
        return;
      }
      case 'BLOCKQUOTE': {
        const t = inlineText(el);
        if (t) block(() => emit((md ? '> ' : '') + t));
        return;
      }
      case 'A': {
        const href = el.getAttribute('href');
        const t = inlineText(el);
        if (md && href && t && !/^(javascript:|#)/i.test(href)) line += '[' + t + '](' + abs(href) + ')';
        else walkChildren(el, depth);
        return;
      }
      case 'IMG': {
        const alt = (el.getAttribute('alt') || '').trim();
        if (md && alt) line += '![' + alt + '](' + abs(el.getAttribute('src') || '') + ')';
        return;
      }
      case 'INPUT': case 'TEXTAREA': case 'SELECT': {
        const type = (el.getAttribute('type') || '').toLowerCase();
        if (type === 'hidden' || type === 'submit' || type === 'button') { if (el.value) line += ' [' + el.value + '] '; return; }
        const label = el.getAttribute('aria-label') || el.getAttribute('placeholder') || '';
        let v = tag === 'SELECT' ? (el.selectedOptions[0] ? el.selectedOptions[0].label : '') : (type === 'checkbox' || type === 'radio') ? (el.checked ? '✓' : '☐') : el.value;
        if (v && hasSensitiveValue(el)) v = '[redacted]';
        if (v && v.length > 200) v = v.slice(0, 200) + '…';
        const shown = v ? (label ? label + ': ' + v : v) : label;
        if (shown) line += ' [' + shown.replace(/\\s+/g, ' ') + '] ';
        return;
      }
      case 'CODE': {
        const t = el.textContent || '';
        line += md ? '\\u0060' + t + '\\u0060' : t;
        return;
      }
      case 'STRONG': case 'B': {
        if (md) { const t = inlineText(el); if (t) { line += '**' + t + '**'; return; } }
        break;
      }
    }
    if (BLOCK.has(tag) || (!detached && /^(block|flex|grid|list-item|table|flow-root)/.test(getComputedStyle(el).display))) {
      flush();
      walkChildren(el, depth);
      flush();
    } else {
      walkChildren(el, depth);
    }
  };

  walk(root, 0);
  flush();
  // Collapse runs of identical lines (repeated nav in carousels, etc.).
  const lines = [];
  for (const l of out) if (lines[lines.length - 1] !== l) lines.push(l);
  return { text: lines.join('\\n'), title: document.title, truncated, source };
}`;

/** `this` = root element. Returns [{text, url}] of visible links, deduped. */
export const LINKS_FN = `function (limit) {
  const root = this && this.nodeType === 9 ? this : this;
  const seen = new Set();
  const out = [];
  const roots = [root];
  const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
  for (const el of all) if (el.shadowRoot) roots.push(el.shadowRoot);
  for (const r of roots) for (const a of r.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href') || '';
    if (/^(javascript:|mailto:$|#$)/i.test(href)) continue;
    if (typeof a.checkVisibility === 'function' && !a.checkVisibility()) continue;
    let url;
    try { url = new URL(href, document.baseURI).href; } catch (e) { continue; }
    const text = ((a.innerText || a.textContent || '').replace(/\\s+/g, ' ').trim() || a.getAttribute('aria-label') || a.title || '').slice(0, 120);
    const key = url + '\\u0000' + text;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ text, url });
    if (out.length >= limit) break;
  }
  return out;
}`;

/** `this` = root. outerHTML with script/style bodies and inline SVG stripped. */
export const HTML_FN = `function (budget) {
  const src = this && this.nodeType === 9 ? this.documentElement : this;
  const clone = src.cloneNode(true);
  for (const el of clone.querySelectorAll('script,style,noscript,template')) el.textContent = '';
  for (const el of clone.querySelectorAll('svg')) el.innerHTML = '';
  const html = clone.outerHTML;
  return { html: html.length > budget ? html.slice(0, budget) : html, truncated: html.length > budget, length: html.length };
}`;

/** Restore-able visibility spoof + scroll-through for lazy-loaded content. */
export const LAZY_SCROLL_FN = `async function (maxScreens) {
  const se = document.scrollingElement || document.documentElement;
  const start = { top: se.scrollTop, left: se.scrollLeft };
  let last = -1;
  let stable = 0;
  for (let i = 0; i < maxScreens; i++) {
    se.scrollBy({ top: innerHeight * 0.9, behavior: 'instant' });
    await new Promise((r) => setTimeout(r, 350));
    const h = se.scrollHeight;
    const atBottom = se.scrollTop + innerHeight >= h - 4;
    stable = h === last ? stable + 1 : 0;
    last = h;
    if (atBottom && stable >= 1) break;
  }
  se.scrollTo({ top: start.top, left: start.left, behavior: 'instant' });
  return { height: last };
}`;
