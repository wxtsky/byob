import { ReadInput, type Chunk } from '@byob/shared';
import { attachToTab } from '../cdp.js';
import { openOrReuse } from '../tab.js';

const COLLECTOR_INSTALL = `
(() => {
  if (window.__byobCollect) return;

  // Visibility spoof: many lazy-loaders won't fire in background tabs otherwise.
  try {
    Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get: () => 'visible' });
    Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  } catch (_) {}

  let counter = 0;
  const seen = new Set();

  function isVisible(el) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') return false;
    return true;
  }

  window.__byobCollect = function() {
    const out = [];
    const all = document.body ? document.body.querySelectorAll('*') : [];
    for (const el of all) {
      if (el.children && el.children.length > 0) continue;
      const txt = (el.innerText || el.textContent || '').trim();
      if (!txt) continue;
      if (txt.length > 4000) continue;       // skip huge text blobs (likely <script> / <style> leftovers)
      if (!isVisible(el)) continue;
      const key = el.dataset.byobId || (el.dataset.byobId = 'b' + (++counter));
      if (seen.has(key)) continue;
      seen.add(key);
      const r = el.getBoundingClientRect();
      out.push({
        id: key,
        sourceIds: [key],
        text: txt,
        bounds: [Math.round(r.x + window.scrollX), Math.round(r.y + window.scrollY), Math.round(r.width), Math.round(r.height)],
        zIndex: parseInt(getComputedStyle(el).zIndex) || undefined,
      });
    }
    return out;
  };

  window.__byobScrollOnce = function() {
    window.scrollBy({ top: window.innerHeight, behavior: 'instant' });
    return new Promise((resolve) => {
      let settled = false;
      let quietTimer = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        if (quietTimer) clearTimeout(quietTimer);
        clearTimeout(hardTimer);
        resolve();
      };
      const observer = new MutationObserver(() => {
        if (quietTimer) clearTimeout(quietTimer);
        quietTimer = setTimeout(finish, 250);
      });
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src','srcset'] });
      quietTimer = setTimeout(finish, 250);
      const hardTimer = setTimeout(finish, 1500);
    });
  };

  window.__byobAtBottom = function() {
    return (window.innerHeight + window.scrollY) >= (document.documentElement.scrollHeight - 50);
  };
})();
`;

interface CollectedChunk {
  id: string;
  sourceIds: string[];
  text: string;
  bounds: [number, number, number, number];
  zIndex?: number;
}

export async function handleRead(rawParams: unknown): Promise<unknown> {
  const params = ReadInput.parse(rawParams);

  const tab = await openOrReuse({
    url: params.url,
    reuseActive: params.reuseTab,
  });

  const session = await attachToTab(tab.tabId);
  if (!session) {
    if (!tab.reused) await tab.cleanup();
    return {
      error: 'cdp_attach_failed',
      message: 'Could not attach Chrome debugger. Close DevTools (F12) on this tab and retry.',
      hint: 'See byob doctor.',
    };
  }

  const startedAt = Date.now();
  const timeoutAt = startedAt + params.timeoutSec * 1000;
  let stopReason: 'end_of_scroll' | 'timeout' | 'limit_reached' = 'end_of_scroll';
  const allChunks = new Map<string, Chunk>();
  let noGrowthRounds = 0;

  try {
    await session.evaluate(COLLECTOR_INSTALL, { awaitPromise: false });

    for (let i = 0; i < params.screens; i++) {
      if (Date.now() > timeoutAt) {
        stopReason = 'timeout';
        break;
      }

      const got = await session.evaluate<CollectedChunk[]>('window.__byobCollect()', {
        awaitPromise: false,
      });
      const before = allChunks.size;
      for (const c of got ?? []) allChunks.set(c.id, c as Chunk);
      const grew = allChunks.size > before;
      if (!grew) noGrowthRounds++;
      else noGrowthRounds = 0;

      const atBottom = await session.evaluate<boolean>('window.__byobAtBottom()', {
        awaitPromise: false,
      });
      if (atBottom) {
        stopReason = 'end_of_scroll';
        break;
      }
      if (noGrowthRounds >= 2) {
        stopReason = 'end_of_scroll';
        break;
      }
      if (i === params.screens - 1) {
        stopReason = 'limit_reached';
        break;
      }

      await session.evaluate('window.__byobScrollOnce()', { awaitPromise: true });
    }

    const tabInfo = await chrome.tabs.get(tab.tabId);
    const sessionId = params.sessionId ?? crypto.randomUUID();
    const chunks = [...allChunks.values()].sort(
      (a, b) => a.bounds[1] - b.bounds[1] || a.bounds[0] - b.bounds[0],
    );
    const text = chunks.map((c) => c.text).join('\n\n');

    return {
      text,
      title: tabInfo.title ?? '',
      url: tabInfo.url ?? params.url,
      chunks,
      sessionId,
      canContinue: stopReason !== 'end_of_scroll',
      stopReason,
    };
  } finally {
    if (!tab.reused) {
      await session.detach();
      await tab.cleanup();
    }
  }
}
