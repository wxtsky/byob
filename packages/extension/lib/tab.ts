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
      await chrome.tabs.update(opts.tabId, { url: opts.url });
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
        await chrome.tabs.update(active.id, { url: opts.url });
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
