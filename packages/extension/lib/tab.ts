export interface OpenedTab {
  tabId: number;
  reused: boolean;
  /** Caller calls this when done; closes the tab unless reused. */
  cleanup: () => Promise<void>;
}

export function waitForLoad(tabId: number, timeoutMs = 30_000): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err?: Error): void => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
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
  });
}

export async function openOrReuse(opts: {
  url?: string;
  tabId?: number;
  reuseActive?: boolean;
}): Promise<OpenedTab> {
  // Explicit tabId wins
  if (opts.tabId !== undefined) {
    const tab = await chrome.tabs.get(opts.tabId);
    if (opts.url && tab.url !== opts.url) {
      await chrome.tabs.update(opts.tabId, { url: opts.url });
      await waitForLoad(opts.tabId, 30_000);
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
        await waitForLoad(active.id, 30_000);
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

  // Open a new background tab
  if (!opts.url) throw new Error('openOrReuse: url required when not reusing');
  const created = await chrome.tabs.create({ url: opts.url, active: false });
  const tabId = created.id!;
  await waitForLoad(tabId, 30_000);
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
