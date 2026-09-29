/**
 * Element references (`e12`) handed to the agent by snapshot / find.
 *
 * A ref is bound to a backend DOM node id inside one document of one frame.
 * The binding lives in service-worker memory — the page itself is never
 * stamped with attributes, so refs cannot leak to (or be spoofed by) the page.
 *
 * Stability rules:
 *  - the same node gets the same ref across snapshots of the same document;
 *  - numbers are never reused within a tab, so an old ref can never silently
 *    point at a different element after the page changes;
 *  - the document identity (frame loaderId) is recorded, and resolution
 *    refuses refs whose document has since been replaced.
 */

export interface RefEntry {
  ref: string;
  backendNodeId: number;
  frameId: string;
  /** Flatten-attached child session for out-of-process iframes. */
  sessionId?: string;
  /** Frame document identity at the time the ref was minted. */
  loaderId?: string;
  role: string;
  name: string;
  /** Index among controls with the same role+name in that frame; -1 = unknown. */
  nth: number;
  /** How many such controls the frame had when `nth` was recorded. */
  total?: number;
}

interface TabRefs {
  byRef: Map<string, RefEntry>;
  byKey: Map<string, string>;
}

// One counter for the whole extension: refs are unique across tabs, so a
// bare ref always names exactly one tab and can't be confused with another
// tab's snapshot.
let nextRef = 1;

/** Oldest refs are evicted beyond this; long agent sessions on one SPA tab
 *  would otherwise grow without bound. */
const MAX_REFS_PER_TAB = 5000;

const tabs = new Map<number, TabRefs>();

function tabRefs(tabId: number): TabRefs {
  let t = tabs.get(tabId);
  if (!t) {
    t = { byRef: new Map(), byKey: new Map() };
    tabs.set(tabId, t);
  }
  return t;
}

function keyOf(e: Pick<RefEntry, 'backendNodeId' | 'sessionId' | 'loaderId'>): string {
  return `${e.sessionId ?? ''}|${e.loaderId ?? ''}|${e.backendNodeId}`;
}

/**
 * Return the existing ref for this node, or mint a new one. Relocation hints
 * (role/name/nth) are only (re)written from whole-document views — a scoped
 * snapshot or a find result counts duplicates in a subset, which would make
 * `nth` point at the wrong one.
 */
export function refFor(tabId: number, entry: Omit<RefEntry, 'ref'>, opts: { hints?: boolean } = {}): string {
  const t = tabRefs(tabId);
  const key = keyOf(entry);
  const existing = t.byKey.get(key);
  if (existing) {
    const cur = t.byRef.get(existing);
    if (cur && opts.hints !== false && entry.nth >= 0) {
      cur.role = entry.role;
      cur.name = entry.name;
      cur.nth = entry.nth;
      cur.total = undefined;
    }
    return existing;
  }
  const ref = `e${nextRef++}`;
  t.byRef.set(ref, opts.hints === false ? { ...entry, nth: -1, ref } : { ...entry, ref });
  t.byKey.set(key, ref);
  if (t.byRef.size > MAX_REFS_PER_TAB) {
    const oldest = t.byRef.keys().next().value as string;
    const old = t.byRef.get(oldest);
    t.byRef.delete(oldest);
    if (old) t.byKey.delete(keyOf(old));
  }
  return ref;
}

/** After a whole-document snapshot: how many controls share each ref's
 *  role+name in its frame, so relocation can insist on the same shape. */
export function setTotals(tabId: number, refs: string[]): void {
  const t = tabs.get(tabId);
  if (!t) return;
  const counts = new Map<string, number>();
  const k = (e: RefEntry): string => `${e.sessionId ?? ''}|${e.frameId}|${e.role}\u0000${e.name}`;
  for (const r of refs) {
    const e = t.byRef.get(r);
    if (e && e.nth >= 0) counts.set(k(e), (counts.get(k(e)) ?? 0) + 1);
  }
  for (const r of refs) {
    const e = t.byRef.get(r);
    if (e && e.nth >= 0) e.total = counts.get(k(e));
  }
}

export function lookupRef(tabId: number, ref: string): RefEntry | undefined {
  return tabs.get(tabId)?.byRef.get(ref);
}

/** Find which tab minted a ref — lets a tool accept a bare ref without tabId. */
export function tabOfRef(ref: string): number | undefined {
  for (const [tabId, t] of tabs) if (t.byRef.has(ref)) return tabId;
  return undefined;
}

/** Accept `e12`, `@e12`, `ref=e12`, `[ref=e12]`. */
export function normalizeRef(raw: string): string | null {
  const m = /^\s*\[?(?:ref=)?@?(e\d+)\]?\s*$/i.exec(raw);
  return m ? m[1]!.toLowerCase() : null;
}

export function forgetTabRefs(tabId: number): void {
  tabs.delete(tabId);
}

function onTabRemoved(tabId: number): void {
  forgetTabRefs(tabId);
}
if (typeof chrome !== 'undefined' && chrome.tabs?.onRemoved) {
  if (!chrome.tabs.onRemoved.hasListener?.(onTabRemoved)) {
    chrome.tabs.onRemoved.addListener(onTabRemoved);
  }
}

/** Test-only. */
export function _resetRefsForTests(): void {
  tabs.clear();
  nextRef = 1;
}
