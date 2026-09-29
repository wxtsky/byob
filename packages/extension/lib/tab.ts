import { abortError } from './signal-utils.js';

export interface OpenedTab {
  tabId: number;
  reused: boolean;
  /** Caller calls this when done; closes the tab unless reused. */
  cleanup: () => Promise<void>;
}

export function waitForLoad(
  tabId: number,
  timeoutMs = 30_000,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false;
    let abortListener: (() => void) | null = null;
    const finish = (err?: Error): void => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      if (signal && abortListener) signal.removeEventListener('abort', abortListener);
      if (err) reject(err);
      else resolve();
    };
    const listener = (updatedId: number, info: chrome.tabs.TabChangeInfo): void => {
      if (updatedId === tabId && info.status === 'complete') finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs
      .get(tabId)
      .then((t) => {
        if (t.status === 'complete') finish();
      })
      .catch(() => {
        // tab gone — let timeout fire below
      });
    const timer = setTimeout(
      () => finish(new Error(`tab ${tabId} did not load within ${timeoutMs}ms`)),
      timeoutMs,
    );
    if (signal) {
      if (signal.aborted) {
        finish(abortError(typeof signal.reason === 'string' ? signal.reason : 'aborted'));
        return;
      }
      abortListener = (): void => {
        finish(abortError(typeof signal.reason === 'string' ? signal.reason : 'aborted'));
      };
      signal.addEventListener('abort', abortListener, { once: true });
    }
  });
}

export async function openOrReuse(opts: {
  url?: string;
  tabId?: number;
  reuseActive?: boolean;
  signal?: AbortSignal;
}): Promise<OpenedTab> {
  // Explicit tabId wins
  if (opts.tabId !== undefined) {
    const tab = await chrome.tabs.get(opts.tabId);
    if (opts.url && tab.url !== opts.url) {
      // active:false — don't yank the tab to the foreground when we
      // navigate it. Chrome no-ops this on a tab that is already active,
      // so existing user focus is preserved either way.
      await chrome.tabs.update(opts.tabId, { url: opts.url, active: false });
      await waitForLoad(opts.tabId, 30_000, opts.signal);
    }
    return {
      tabId: opts.tabId,
      reused: true,
      cleanup: async () => {
        // don't close caller-owned tab
      },
    };
  }

  // Reuse current active tab in last-focused window
  if (opts.reuseActive) {
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (active?.id !== undefined) {
      if (opts.url && active.url !== opts.url) {
        // active:false — same rationale as the explicit-tabId branch
        // above. The tab is already active here so this is a no-op for
        // focus, but keeping it consistent prevents any future Chrome
        // behavior shift from re-introducing the focus-steal bug.
        await chrome.tabs.update(active.id, { url: opts.url, active: false });
        await waitForLoad(active.id, 30_000, opts.signal);
      }
      return {
        tabId: active.id,
        reused: true,
        cleanup: async () => {
          // don't close user's active tab
        },
      };
    }
  }

  // Open a new background tab in the user's focused normal window so
  // the new tab stays in the window the user is currently looking at,
  // never spawning a stray new window when possible.
  if (!opts.url) throw new Error('openOrReuse: url required when not reusing');
  const wins = await chrome.windows.getAll({ windowTypes: ['normal'] });
  const focusedWindowId = wins.find((w) => w.focused)?.id ?? wins[0]?.id;
  let tabId: number;
  if (focusedWindowId === undefined) {
    // Fallback: no normal window open — create a fresh unfocused one.
    const w = await chrome.windows.create({ url: opts.url, focused: false });
    const firstTab = w?.tabs?.[0];
    if (!firstTab?.id) throw new Error('chrome.windows.create returned no tab');
    tabId = firstTab.id;
  } else {
    const created = await chrome.tabs.create({
      url: opts.url,
      active: false,
      windowId: focusedWindowId,
    });
    tabId = created.id!;
  }
  await waitForLoad(tabId, 30_000, opts.signal);
  return {
    tabId,
    reused: false,
    cleanup: async () => {
      try {
        await chrome.tabs.remove(tabId);
      } catch {
        // already gone
      }
    },
  };
}

// ---------------------------------------------------------------------------
// v0.5: race-free navigation, background tabs, the "byob" tab group
// ---------------------------------------------------------------------------

/**
 * Navigate `tabId` and wait for the *new* document's load. Listening starts
 * before the update is issued and completion only counts after a `loading`
 * transition, so the old page's `complete` status can't end the wait early.
 * Same-document (hash) navigations never go through `loading`; they finish
 * once the URL matches.
 */
export async function navigateAndWait(
  tabId: number,
  url: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  let sawLoading = false;
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));
  const listener = (id: number, info: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab): void => {
    if (id !== tabId) return;
    if (info.status === 'loading') sawLoading = true;
    if (info.status === 'complete' && sawLoading) resolveDone();
    if (!sawLoading && info.url && sameDocTarget(info.url, url) && tab.status === 'complete') resolveDone();
  };
  chrome.tabs.onUpdated.addListener(listener);
  try {
    await chrome.tabs.update(tabId, { url });
    await raceDeadline(done, timeoutMs, `tab ${tabId} did not finish loading within ${timeoutMs}ms`, signal, async () => {
      // Hash-only change: no events beyond the url update may arrive.
      const t = await chrome.tabs.get(tabId).catch(() => null);
      return !!t && !sawLoading && t.status === 'complete' && sameDocTarget(t.url ?? '', url);
    });
  } finally {
    chrome.tabs.onUpdated.removeListener(listener);
  }
}

/** Wait for a history navigation / reload started by `start`. */
export async function actionAndWaitLoad(
  tabId: number,
  start: () => Promise<void>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  let sawLoading = false;
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));
  const listener = (id: number, info: chrome.tabs.TabChangeInfo): void => {
    if (id !== tabId) return;
    if (info.status === 'loading') sawLoading = true;
    if (info.status === 'complete' && sawLoading) resolveDone();
  };
  chrome.tabs.onUpdated.addListener(listener);
  try {
    await start();
    await raceDeadline(done, timeoutMs, `tab ${tabId} did not finish loading within ${timeoutMs}ms`, signal, async () => {
      // bfcache restores and same-document history steps may skip `loading`.
      const t = await chrome.tabs.get(tabId).catch(() => null);
      return !!t && t.status === 'complete' && !sawLoading;
    }, 1200);
  } finally {
    chrome.tabs.onUpdated.removeListener(listener);
  }
}

function sameDocTarget(current: string, target: string): boolean {
  try {
    const a = new URL(current);
    const b = new URL(target);
    return a.href === b.href || (a.origin + a.pathname + a.search === b.origin + b.pathname + b.search && a.hash === b.hash);
  } catch {
    return current === target;
  }
}

async function raceDeadline(
  done: Promise<void>,
  timeoutMs: number,
  message: string,
  signal: AbortSignal | undefined,
  quietCheck: () => Promise<boolean>,
  quietAfterMs = 1500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let settled = false;
  void done.then(() => (settled = true));
  const quietAt = Date.now() + quietAfterMs;
  while (!settled) {
    if (signal?.aborted) throw abortError(typeof signal.reason === 'string' ? signal.reason : 'aborted');
    if (Date.now() >= deadline) throw new Error(message);
    await Promise.race([done, new Promise((r) => setTimeout(r, 150))]);
    if (!settled && Date.now() >= quietAt && (await quietCheck())) return;
  }
}

const GROUP_TITLE = 'byob';
const groupsByWindow = new Map<number, number>();

/** Put an agent-opened tab into the window's "byob" group (best effort). */
export async function addToByobGroup(tabId: number): Promise<void> {
  if (!chrome.tabGroups || !chrome.tabs.group) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    const windowId = tab.windowId;
    let groupId = groupsByWindow.get(windowId);
    if (groupId !== undefined) {
      try {
        await chrome.tabGroups.get(groupId);
      } catch {
        groupId = undefined;
      }
    }
    if (groupId === undefined) {
      const existing = await chrome.tabGroups.query({ windowId, title: GROUP_TITLE });
      groupId = existing[0]?.id;
    }
    if (groupId === undefined) {
      groupId = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId } });
      await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: 'blue', collapsed: false });
    } else {
      await chrome.tabs.group({ tabIds: [tabId], groupId });
    }
    groupsByWindow.set(windowId, groupId);
  } catch (e) {
    console.warn('[byob/tab] grouping failed (non-fatal):', e);
  }
}

/**
 * Open a background tab for the agent in the user's focused window, grouped
 * under "byob". Never steals focus.
 */
export async function openAgentTab(url: string, opts: { active?: boolean; group?: boolean } = {}): Promise<number> {
  const wins = await chrome.windows.getAll({ windowTypes: ['normal'] });
  const windowId = wins.find((w) => w.focused)?.id ?? wins[0]?.id;
  let tabId: number;
  if (windowId === undefined) {
    const w = await chrome.windows.create({ url, focused: false });
    tabId = w?.tabs?.[0]?.id ?? -1;
    if (tabId < 0) throw new Error('chrome.windows.create returned no tab');
  } else {
    const t = await chrome.tabs.create({ url, active: opts.active ?? false, windowId });
    tabId = t.id!;
  }
  if (opts.group !== false) await addToByobGroup(tabId);
  return tabId;
}

/** The tab the user is looking at (last-focused normal window). */
export async function activeTabId(): Promise<number | null> {
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (t?.id !== undefined) return t.id;
  const [any] = await chrome.tabs.query({ active: true });
  return any?.id ?? null;
}

/** Wait for a freshly created tab to finish loading its first real URL. */
export function waitFirstLoad(tabId: number, timeoutMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const check = (t: chrome.tabs.Tab): boolean =>
      t.status === 'complete' && !!t.url && t.url !== 'about:blank';
    const listener = (id: number, _i: chrome.tabs.TabChangeInfo, t: chrome.tabs.Tab): void => {
      if (id === tabId && check(t)) finish();
    };
    const timer = setTimeout(() => finish(new Error(`tab ${tabId} did not finish loading within ${timeoutMs}ms`)), timeoutMs);
    const onAbort = (): void => finish(new DOMException('aborted', 'AbortError') as unknown as Error);
    let done = false;
    function finish(err?: Error): void {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      signal.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else resolve();
    }
    chrome.tabs.onUpdated.addListener(listener);
    signal.addEventListener('abort', onAbort, { once: true });
    chrome.tabs.get(tabId).then((t) => check(t) && finish(), () => finish(new Error('tab closed')));
  });
}

