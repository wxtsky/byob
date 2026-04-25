const buckets = new Map<number, number[]>();
const WINDOW_MS = 60_000;
const LIMIT_PER_WINDOW = 5;

export function recordAndCheckRate(tabId: number): boolean {
  const now = Date.now();
  const arr = (buckets.get(tabId) ?? []).filter((t) => now - t < WINDOW_MS);
  arr.push(now);
  buckets.set(tabId, arr);
  return arr.length <= LIMIT_PER_WINDOW;
}

export function notifyEval(tabId: number, url: string, code: string): void {
  const id = `byob-eval-${tabId}-${Date.now()}`;
  void chrome.notifications.create(id, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icon/128.png'),
    title: 'byob: evaluating JS',
    message: `tab ${tabId} (${url})\n${code.slice(0, 80)}${code.length > 80 ? '…' : ''}`,
    requireInteraction: false,
  });
}
