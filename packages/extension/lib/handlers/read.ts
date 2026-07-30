import { ReadInput, type Chunk, type InteractiveElement } from '@byob/shared';
import { tryAttachToTab } from '../cdp.js';
import { attachErrorEnvelope } from '../attach-error.js';
import { openOrReuse } from '../tab.js';
import { checkUrlAllowed, urlForbiddenError } from '../url-guard.js';
import { keepAwakeStart, keepAwakeEnd } from '../keepalive.js';
import { installBeforeunloadGuard, uninstallBeforeunloadGuard } from '../beforeunload-guard.js';
import {
  resolveFrame,
  evaluateInResolvedFrame,
  frameErrorToEnvelope,
} from '../frame-resolver.js';
import { sleepWithSignal, throwIfAborted } from '../signal-utils.js';
import {
  COLLECT_INTERACTIVE_SCRIPT,
  type CollectInteractiveResult,
} from '../clickable-detector.js';

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

export async function handleRead(
  rawParams: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const params = ReadInput.parse(rawParams);
  const guard = checkUrlAllowed(params.url);
  if (!guard.ok) return urlForbiddenError(guard.reason);
  throwIfAborted(signal);

  const tab = await openOrReuse({
    url: params.url,
    reuseActive: params.reuseTab,
    signal,
  });

  const attachResult = await tryAttachToTab(tab.tabId, signal);
  const { session } = attachResult;
  if (!session) {
    if (!tab.reused) await tab.cleanup();
    return attachErrorEnvelope(attachResult, { what: 'read' });
  }

  let frame;
  try {
    frame = await resolveFrame(session, params.framePath, signal);
  } catch (e) {
    if (!tab.reused) await tab.cleanup();
    const env = frameErrorToEnvelope(e);
    if (env) return env;
    throw e;
  }

  const startedAt = Date.now();
  const timeoutAt = startedAt + params.timeoutSec * 1000;
  let stopReason: 'end_of_scroll' | 'timeout' | 'limit_reached' = 'end_of_scroll';
  const allChunks = new Map<string, Chunk>();
  let noGrowthRounds = 0;
  let lastScrollHeight = 0;
  let stableHeightRounds = 0;

  // keepAwake + beforeunload guard MUST be inside the try so `finally` always
  // releases them even if installBeforeunloadGuard somehow throws.
  keepAwakeStart();
  try {
    await installBeforeunloadGuard(session);
    await evaluateInResolvedFrame(session, frame, COLLECTOR_INSTALL, {
      awaitPromise: false,
      signal,
    });

    // SPA priming: many lazy-loaded sites (X, FB, Reddit-new etc.) render
    // ~nothing on initial load and only kick in after the first scroll event.
    // Without this, scrollHeight stays ≈ viewport and __byobAtBottom returns
    // true on round 1, causing the loop to break with zero content.
    await evaluateInResolvedFrame(session, frame, 'window.__byobScrollOnce()', {
      awaitPromise: true,
      signal,
    });
    await evaluateInResolvedFrame(session, frame, 'window.scrollTo(0, 0)', {
      awaitPromise: false,
      signal,
    });
    await sleepWithSignal(200, signal);

    for (let i = 0; i < params.screens; i++) {
      throwIfAborted(signal);
      if (Date.now() > timeoutAt) {
        stopReason = 'timeout';
        break;
      }

      const got = await evaluateInResolvedFrame<CollectedChunk[]>(
        session,
        frame,
        'window.__byobCollect()',
        { awaitPromise: false, signal },
      );
      const before = allChunks.size;
      for (const c of got ?? []) allChunks.set(c.id, c as Chunk);
      const grew = allChunks.size > before;
      if (!grew) noGrowthRounds++;
      else noGrowthRounds = 0;

      // Track scrollHeight stability — a moving "bottom" means SPA is still
      // lazy-loading content, so don't trust atBottom alone.
      const curHeight = await evaluateInResolvedFrame<number>(
        session,
        frame,
        'document.documentElement.scrollHeight',
        { awaitPromise: false, signal },
      );
      if (curHeight === lastScrollHeight) stableHeightRounds++;
      else stableHeightRounds = 0;
      lastScrollHeight = curHeight;

      const atBottom = await evaluateInResolvedFrame<boolean>(
        session,
        frame,
        'window.__byobAtBottom()',
        { awaitPromise: false, signal },
      );
      // Real end-of-scroll requires atBottom AND height has been stable for
      // at least one round AND no new content this round. This avoids the
      // SPA-priming race where round-1 atBottom is true but the page hasn't
      // rendered anything yet.
      if (atBottom && stableHeightRounds >= 1 && !grew) {
        stopReason = 'end_of_scroll';
        break;
      }
      if (noGrowthRounds >= 2 && stableHeightRounds >= 1) {
        stopReason = 'end_of_scroll';
        break;
      }
      if (i === params.screens - 1) {
        stopReason = 'limit_reached';
        break;
      }

      await evaluateInResolvedFrame(session, frame, 'window.__byobScrollOnce()', {
        awaitPromise: true,
        signal,
      });
    }

    const tabInfo = await chrome.tabs.get(tab.tabId);
    const sessionId = params.sessionId ?? crypto.randomUUID();
    const chunks = [...allChunks.values()].sort(
      (a, b) => a.bounds[1] - b.bounds[1] || a.bounds[0] - b.bounds[0],
    );
    const text = chunks.map((c) => c.text).join('\n\n');

    // Collect interactive elements after scroll/lazy-load has settled. This
    // tags every match with `data-byob-idx="N"` in the DOM so the agent can
    // later target them via `selector: 'byob:idx=N'` from browser_click /
    // browser_type. We only run on the resolved frame — iframe support is a
    // follow-up. A failure here must not break the read response, so we
    // catch and silently omit the field.
    let interactiveElements: InteractiveElement[] | undefined;
    let interactiveSessionTag: string | undefined;
    try {
      const collected = await evaluateInResolvedFrame<CollectInteractiveResult>(
        session,
        frame,
        COLLECT_INTERACTIVE_SCRIPT,
        { awaitPromise: false, signal },
      );
      if (collected && Array.isArray(collected.interactiveElements)) {
        interactiveElements = collected.interactiveElements;
        interactiveSessionTag = collected.sessionTag;
      }
    } catch (_) {
      // Don't let a collector exception (e.g. detached frame, OOPIF quirk)
      // wipe out a successful read.
    }

    return {
      text,
      title: tabInfo.title ?? '',
      url: tabInfo.url ?? params.url,
      chunks,
      sessionId,
      canContinue: stopReason !== 'end_of_scroll',
      stopReason,
      ...(interactiveElements ? { interactiveElements } : {}),
      // sessionTag changes per page-load; comparing against the value from
      // your last read tells you whether idx values are still valid.
      ...(interactiveSessionTag ? { interactiveSessionTag } : {}),
    };
  } finally {
    await uninstallBeforeunloadGuard(session);
    keepAwakeEnd();
    if (!tab.reused) {
      await session.detach();
      await tab.cleanup();
    }
  }
}
