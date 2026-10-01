/**
 * One operation per tab at a time.
 *
 * Every MCP session has its own byob-mcp process, but they all land in this
 * one service worker. Two sessions acting on the same tab would otherwise
 * interleave: keystrokes of two `type` calls mixed together, a click landing
 * while another call has the page scrolled or its viewport emulated, focus
 * stolen mid-action. The dispatcher takes this lock (FIFO per tab) around
 * each handler.
 *
 * Not locked:
 *  - meta / tab-less commands: tabs, console (buffered, read-only), clipboard,
 *    policy;
 *  - dialog: an action can be stuck behind the very dialog the agent needs to
 *    answer, so answering must never queue behind it;
 *  - wait / downloads: passive polls that can run for minutes; holding the
 *    tab would make other sessions' actions time out behind them;
 *  - calls that open their URL in a new tab (nobody else can be using it).
 */
import { normalizeRef, tabOfRef } from './refs.js';
import { activeTabId } from './tab.js';
import { raceWithSignal } from './signal-utils.js';

const UNLOCKED = new Set(['tabs', 'console', 'clipboard', 'policy', 'dialog', 'wait', 'downloads']);

export interface TabResolvers {
  tabOfRef: (ref: string) => number | undefined;
  activeTabId: () => Promise<number | null>;
}

const defaultResolvers: TabResolvers = { tabOfRef, activeTabId };

/**
 * The tab a command will act on — the same choice as the handlers' pickTab
 * (tabId, else the ref's tab, else the active tab) — or null when the command
 * needs no lock.
 */
export async function lockKeyFor(
  command: string,
  params: unknown,
  r: TabResolvers = defaultResolvers,
): Promise<number | null> {
  if (UNLOCKED.has(command)) return null;
  const p = (params ?? {}) as Record<string, unknown>;
  const opensNewTab =
    command === 'navigate'
      ? (p.action ?? 'goto') === 'goto' && (p.newTab === true || p.tabId === undefined)
      : (typeof p.url === 'string' && p.url !== '' && p.tabId === undefined) ||
        // browser_read {urls}: only ever touches the tabs it opens itself.
        (Array.isArray(p.urls) && p.urls.length > 0);
  if (opensNewTab) return null;
  if (typeof p.tabId === 'number') return p.tabId;
  const end = (v: unknown): unknown => (v && typeof v === 'object' ? (v as { ref?: unknown }).ref : undefined);
  for (const raw of [p.ref, p.within, end(p.from), end(p.to)]) {
    if (typeof raw !== 'string') continue;
    const ref = normalizeRef(raw);
    const owner = ref ? r.tabOfRef(ref) : undefined;
    if (owner !== undefined) return owner;
  }
  return r.activeTabId();
}

/** FIFO async mutex per key. Waiting honours the AbortSignal. */
export function createKeyedLock<K>(): {
  acquire: (key: K, signal: AbortSignal) => Promise<() => void>;
  busy: (key: K) => boolean;
} {
  const tails = new Map<K, Promise<void>>();
  return {
    busy: (key) => tails.has(key),
    async acquire(key, signal) {
      const prev = tails.get(key) ?? Promise.resolve();
      let open!: () => void;
      const done = new Promise<void>((resolve) => { open = resolve; });
      const tail = prev.then(() => done);
      tails.set(key, tail);
      void tail.then(() => {
        if (tails.get(key) === tail) tails.delete(key);
      });
      try {
        await raceWithSignal(prev, signal);
      } catch (e) {
        // Gave up waiting: our turn passes straight to whoever is behind us.
        open();
        throw e;
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        open();
      };
    },
  };
}

export const tabLock = createKeyedLock<number>();
