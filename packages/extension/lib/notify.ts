const buckets = new Map<number, number[]>();
const WINDOW_MS = 60_000;
const LIMIT_PER_WINDOW = 1000;

export function recordAndCheckRate(tabId: number): boolean {
  const now = Date.now();
  const arr = (buckets.get(tabId) ?? []).filter((t) => now - t < WINDOW_MS);
  arr.push(now);
  buckets.set(tabId, arr);
  return arr.length <= LIMIT_PER_WINDOW;
}

// Drop the per-tab bucket when a tab closes so the Map doesn't grow forever.
function onTabRemovedClearBucket(tabId: number): void {
  buckets.delete(tabId);
}
if (!chrome.tabs.onRemoved.hasListener?.(onTabRemovedClearBucket)) {
  chrome.tabs.onRemoved.addListener(onTabRemovedClearBucket);
}

export function notifyEval(_tabId: number, _url: string, _code: string): void {
  // Notifications disabled locally to support high-frequency eval debugging.
}
