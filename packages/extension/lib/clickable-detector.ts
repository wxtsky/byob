/**
 * Interactive-element detector — runs in the page (not the SW).
 *
 * Adapted from browser-use's `ClickableElementDetector.is_interactive()` but
 * implemented as plain DOM JS so it can be `Runtime.evaluate`-injected. The
 * Python original walks an enriched DOM/AX tree on the agent side; here we
 * approximate the same heuristics with what's available in-page (computed
 * styles, ARIA attrs, getBoundingClientRect, dataset). The whole detector is
 * exported as a single string template (`COLLECT_INTERACTIVE_SCRIPT`) — an
 * IIFE that returns `{ interactiveElements, sessionTag }`.
 *
 * Each matched element is tagged in the DOM with `data-byob-idx="N"` so the
 * agent can later target it via `selector: 'byob:idx=N'` (resolved in the
 * click/type handlers). The idx is monotonically increasing within a page
 * load — SPA re-renders or navigations invalidate previous indices, so the
 * agent must re-run browser_read to refresh them.
 *
 * Skip rules (kept simple on purpose):
 *   - getComputedStyle: display:none, visibility:hidden, opacity:0
 *   - getBoundingClientRect with width=0 or height=0
 *   - disabled / aria-disabled=true
 * We deliberately do NOT do paint-order occlusion testing (browser-use does
 * via CDP DOMSnapshot.paintOrders) — too expensive over Runtime.evaluate
 * and the false-positive cost is low: agents tolerate clicking a covered
 * element better than they tolerate missing real buttons.
 *
 * Accessible-name precedence (matches what most ARIA testing libs do):
 *   aria-label  >  aria-labelledby (joined IDREF text)  >
 *   visible textContent (truncated 80 chars)  >  placeholder  >  title  >  alt
 */

export const COLLECT_INTERACTIVE_SCRIPT = `(() => {
  const INTERACTIVE_TAGS = new Set([
    'a', 'button', 'input', 'select', 'textarea',
    'label', 'summary', 'details', 'option',
  ]);
  const INTERACTIVE_ROLES = new Set([
    'button', 'link', 'checkbox', 'radio', 'switch',
    'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
    'option', 'treeitem', 'combobox', 'textbox', 'searchbox',
    'slider', 'spinbutton', 'gridcell', 'cell', 'row',
    'listbox',
  ]);
  const NAME_HINTS = ['btn', 'button', 'click', 'menu', 'nav', 'tab-', 'link', 'toggle'];

  function isVisible(el, cs, rect) {
    if (!rect || rect.width === 0 || rect.height === 0) return false;
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    const op = parseFloat(cs.opacity);
    if (!isNaN(op) && op === 0) return false;
    return true;
  }

  function isDisabled(el) {
    if (el.disabled === true) return true;
    const ariaDis = el.getAttribute && el.getAttribute('aria-disabled');
    if (ariaDis === 'true' || ariaDis === '') return true;
    return false;
  }

  function tabindexInteractive(el) {
    const ti = el.getAttribute && el.getAttribute('tabindex');
    if (ti === null || ti === undefined) return false;
    const n = parseInt(ti, 10);
    return Number.isFinite(n) && n >= 0;
  }

  function nameHintMatches(el) {
    const cls = (el.className && typeof el.className === 'string' ? el.className : '').toLowerCase();
    const id = (el.id || '').toLowerCase();
    const blob = cls + ' ' + id;
    for (const h of NAME_HINTS) if (blob.indexOf(h) !== -1) return true;
    return false;
  }

  // Heuristic stack — ordered strongest → weakest. Returns the role label
  // we'll surface, or null if non-interactive.
  function classify(el, cs) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'html' || tag === 'body') return null;

    // Explicit role wins over tag inference.
    const roleAttr = el.getAttribute && el.getAttribute('role');
    if (roleAttr && INTERACTIVE_ROLES.has(roleAttr.toLowerCase())) {
      return roleAttr.toLowerCase();
    }

    // Tag whitelist (strongest signal after explicit role).
    if (INTERACTIVE_TAGS.has(tag)) {
      if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'a';
      if (tag === 'button') return 'button';
      if (tag === 'input') {
        const t = (el.getAttribute('type') || 'text').toLowerCase();
        if (t === 'hidden') return null;
        return 'input';
      }
      if (tag === 'select') return 'combobox';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'label') {
        // Skip labels with "for" — clicking the label triggers the linked
        // input, so we'd double-count. Let the input itself surface.
        if (el.hasAttribute('for')) return null;
        return 'label';
      }
      if (tag === 'summary') return 'button';
      if (tag === 'details') return 'group';
      if (tag === 'option') return 'option';
    }

    // Explicit click handler attribute (DOM API can't see addEventListener
    // listeners, but onclick="..." is reachable via getAttribute).
    if (el.hasAttribute && el.hasAttribute('onclick')) return 'button';

    // ARIA popup / expand / control hints.
    if (el.hasAttribute && (
      el.hasAttribute('aria-haspopup') ||
      el.hasAttribute('aria-expanded') ||
      el.hasAttribute('aria-controls')
    )) return 'button';

    // contenteditable
    const ce = el.getAttribute && el.getAttribute('contenteditable');
    if (ce && ce !== 'false') return 'textbox';

    // tabindex >= 0
    if (tabindexInteractive(el)) return 'button';

    // cursor: pointer (last reliable signal; cheap-ish since we already
    // have computed style for visibility).
    if (cs && cs.cursor === 'pointer') return 'button';

    // Naming heuristic — weakest. Only trip if the tag isn't a layout
    // container that commonly carries these names without being clickable
    // (e.g. <nav>/<menu> wrappers).
    if (tag !== 'nav' && tag !== 'menu' && tag !== 'ul' && tag !== 'ol' && nameHintMatches(el)) {
      return 'button';
    }

    return null;
  }

  function accessibleName(el) {
    const al = el.getAttribute && el.getAttribute('aria-label');
    if (al && al.trim()) return al.trim().slice(0, 200);

    const lb = el.getAttribute && el.getAttribute('aria-labelledby');
    if (lb) {
      const ids = lb.split(/\\s+/).filter(Boolean);
      const parts = [];
      for (const id of ids) {
        const ref = document.getElementById(id);
        if (ref && ref.textContent) parts.push(ref.textContent.trim());
      }
      if (parts.length) return parts.join(' ').slice(0, 200);
    }

    // For inputs the value/placeholder is more useful than textContent.
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea') {
      const ph = el.getAttribute('placeholder');
      if (ph && ph.trim()) return ph.trim().slice(0, 200);
      const val = el.value;
      if (typeof val === 'string' && val.trim()) return val.trim().slice(0, 200);
    }

    if (tag === 'img') {
      const alt = el.getAttribute('alt');
      if (alt && alt.trim()) return alt.trim().slice(0, 200);
    }

    const tc = (el.textContent || '').trim().replace(/\\s+/g, ' ');
    if (tc) return tc.slice(0, 80);

    const title = el.getAttribute && el.getAttribute('title');
    if (title && title.trim()) return title.trim().slice(0, 200);

    const alt = el.getAttribute && el.getAttribute('alt');
    if (alt && alt.trim()) return alt.trim().slice(0, 200);

    return undefined;
  }

  // Idempotent counter — initialize once per page load. Re-running
  // collect should keep tagging from where we left off so previous idx
  // values stay valid within the same browser_read session.
  if (typeof window.__byobInteractiveCounter !== 'number') {
    window.__byobInteractiveCounter = 0;
  }
  if (!window.__byobInteractiveSessionTag) {
    window.__byobInteractiveSessionTag = 'byob-' + Date.now().toString(36);
  }

  const results = [];
  const all = document.body ? document.body.querySelectorAll('*') : [];
  // Hard caps so a runaway SPA (50k+ nodes) doesn't lock up the page.
  // 30k nodes scanned + 1k matches kept covers every real-world site we've
  // seen; agents rarely need more than a few hundred targets per view.
  const MAX_NODES = 30000;
  const MAX_RESULTS = 1000;
  const scanLimit = Math.min(all.length, MAX_NODES);
  for (let i = 0; i < scanLimit; i++) {
    if (results.length >= MAX_RESULTS) break;
    const el = all[i];
    if (!(el instanceof Element)) continue;
    if (isDisabled(el)) continue;

    let cs;
    try { cs = getComputedStyle(el); } catch (_) { continue; }
    if (!cs) continue;

    const rect = el.getBoundingClientRect();
    if (!isVisible(el, cs, rect)) continue;

    const role = classify(el, cs);
    if (!role) continue;

    // Reuse existing idx if we've already tagged this element on a prior
    // collect call (e.g. multiple read passes during scroll). Otherwise
    // assign a fresh monotonically-increasing one.
    let idx;
    const existing = el.getAttribute('data-byob-idx');
    if (existing && /^[0-9]+$/.test(existing)) {
      idx = parseInt(existing, 10);
    } else {
      idx = ++window.__byobInteractiveCounter;
      el.setAttribute('data-byob-idx', String(idx));
    }

    const tag = el.tagName.toLowerCase();
    const entry = {
      idx: idx,
      tag: tag,
      role: role,
      bounds: [
        Math.round(rect.x + window.scrollX),
        Math.round(rect.y + window.scrollY),
        Math.round(rect.width),
        Math.round(rect.height),
      ],
    };

    const name = accessibleName(el);
    if (name) entry.name = name;

    if (tag === 'input') {
      const t = el.getAttribute('type');
      if (t) entry.inputType = t.toLowerCase();
    }

    if (tag === 'a') {
      const href = el.getAttribute('href');
      if (href) entry.href = href.slice(0, 200);
    }

    results.push(entry);
  }

  return {
    interactiveElements: results,
    sessionTag: window.__byobInteractiveSessionTag,
  };
})()`;

/** Shape returned by the in-page IIFE. Mirrored in shared/schemas.ts. */
export interface InteractiveElement {
  idx: number;
  tag: string;
  role?: string;
  name?: string;
  bounds: [number, number, number, number];
  inputType?: string;
  href?: string;
}

export interface CollectInteractiveResult {
  interactiveElements: InteractiveElement[];
  sessionTag: string;
}
