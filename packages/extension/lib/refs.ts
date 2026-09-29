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
  /** Index among nodes with the same role+name in that frame, for relocation. */
  nth: number;
}

interface TabRefs {
  next: number;
  byRef: Map<string, RefEntry>;
  byKey: Map<string, string>;
}

/** Oldest refs are evicted beyond this; long agent sessions on one SPA tab
 *  would otherwise grow without bound. */
const MAX_REFS_PER_TAB = 5000;

const tabs = new Map<number, TabRefs>();

function tabRefs(tabId: number): TabRefs {
  let t = tabs.get(tabId);
  if (!t) {
    t = { next: 1, byRef: new Map(), byKey: new Map() };
    tabs.set(tabId, t);
  }
  return t;
}

function keyOf(e: Pick<RefEntry, 'backendNodeId' | 'sessionId' | 'loaderId'>): string {
  return `${e.sessionId ?? ''}|${e.loaderId ?? ''}|${e.backendNodeId}`;
}

/** Return the existing ref for this node, or mint a new one. */
export function refFor(tabId: number, entry: Omit<RefEntry, 'ref'>): string {
  const t = tabRefs(tabId);
  const key = keyOf(entry);
  const existing = t.byKey.get(key);
  if (existing) {
    // Role/name drift (a button relabelled "Save" → "Saved") is normal on a
    // live page; keep the relocation hints current.
    const cur = t.byRef.get(existing);
    if (cur) {
      cur.role = entry.role;
      cur.name = entry.name;
      cur.nth = entry.nth;
    }
    return existing;
  }
  const ref = `e${t.next++}`;
  t.byRef.set(ref, { ...entry, ref });
  t.byKey.set(key, ref);
  if (t.byRef.size > MAX_REFS_PER_TAB) {
    const oldest = t.byRef.keys().next().value as string;
    const old = t.byRef.get(oldest);
    t.byRef.delete(oldest);
    if (old) t.byKey.delete(keyOf(old));
  }
  return ref;
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
}
