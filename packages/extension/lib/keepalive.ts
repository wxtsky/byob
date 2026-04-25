// Refcounted wrapper around chrome.power.requestKeepAwake so concurrent
// long-running operations (read / screenshot / future download) don't fight
// each other for the keepawake handle. We use 'display' level so the screen
// also stays on — required because Chrome can throttle/pause some lazy
// loaders when the display sleeps.

let activeOps = 0;

export function keepAwakeStart(): void {
  if (activeOps === 0) {
    try {
      chrome.power.requestKeepAwake('display');
    } catch (e) {
      console.warn('[byob/keepalive] requestKeepAwake failed:', e);
    }
  }
  activeOps++;
}

export function keepAwakeEnd(): void {
  activeOps = Math.max(0, activeOps - 1);
  if (activeOps === 0) {
    try {
      chrome.power.releaseKeepAwake();
    } catch (e) {
      console.warn('[byob/keepalive] releaseKeepAwake failed:', e);
    }
  }
}

/** Wrap an async fn so keepawake is bounded by its lifetime. */
export async function withKeepAwake<T>(fn: () => Promise<T>): Promise<T> {
  keepAwakeStart();
  try {
    return await fn();
  } finally {
    keepAwakeEnd();
  }
}
