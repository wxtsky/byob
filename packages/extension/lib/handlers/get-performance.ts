import { GetPerformanceInput } from '@byob/shared';
import { tryAttachToTab } from '../cdp.js';
import { openOrReuse } from '../tab.js';
import { checkUrlAllowed, urlForbiddenError } from '../url-guard.js';
import { throwIfAborted } from '../signal-utils.js';
import { attachErrorEnvelope } from '../attach-error.js';

interface PerfResult {
  webVitals: {
    LCP: number | null;
    CLS: number | null;
    INP: number | null;
    FCP: number | null;
    TTFB: number | null;
  };
  navigation: {
    domContentLoaded: number;
    loadEvent: number;
    dnsLookup: number;
    tcpConnect: number;
    requestStart: number;
    responseEnd: number;
    transferSize: number;
    encodedBodySize: number;
  } | null;
}

export async function handleGetPerformance(
  rawParams: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const params = GetPerformanceInput.parse(rawParams);
  if (params.url) {
    const guard = checkUrlAllowed(params.url);
    if (!guard.ok) return urlForbiddenError(guard.reason);
  }
  throwIfAborted(signal);

  const tab = await openOrReuse({ url: params.url, tabId: params.tabId, signal });

  // Hoisted so finally can detach. Otherwise Chrome's automation yellow bar
  // lingers on every reused tab.
  let session: import('../cdp.js').CdpSession | null = null;
  try {
    const attached = await tryAttachToTab(tab.tabId, signal);
    if (!attached.session) return attachErrorEnvelope(attached.reason);
    session = attached.session;

    const expr = `new Promise((resolve) => {
      let lcp = null, cls = 0, inp = null, fcp = null;
      let lcpObs = null, clsObs = null, inpObs = null, fcpObs = null;
      try {
        lcpObs = new PerformanceObserver((list) => {
          const e = list.getEntries();
          const last = e[e.length - 1];
          if (last) lcp = last.renderTime || last.loadTime || last.startTime;
        });
        lcpObs.observe({ type: 'largest-contentful-paint', buffered: true });
      } catch (_) {}
      try {
        clsObs = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (!entry.hadRecentInput) cls += entry.value;
          }
        });
        clsObs.observe({ type: 'layout-shift', buffered: true });
      } catch (_) {}
      try {
        inpObs = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (entry.duration > (inp ?? 0)) inp = entry.duration;
          }
        });
        inpObs.observe({ type: 'event', buffered: true, durationThreshold: 40 });
      } catch (_) {}
      try {
        fcpObs = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (entry.name === 'first-contentful-paint') fcp = entry.startTime;
          }
        });
        fcpObs.observe({ type: 'paint', buffered: true });
      } catch (_) {}
      setTimeout(() => {
        try { lcpObs?.disconnect(); } catch (_) {}
        try { clsObs?.disconnect(); } catch (_) {}
        try { inpObs?.disconnect(); } catch (_) {}
        try { fcpObs?.disconnect(); } catch (_) {}
        const nav = performance.getEntriesByType('navigation')[0];
        let navOut = null;
        let ttfb = null;
        if (nav) {
          navOut = {
            domContentLoaded: nav.domContentLoadedEventEnd,
            loadEvent: nav.loadEventEnd,
            dnsLookup: nav.domainLookupEnd - nav.domainLookupStart,
            tcpConnect: nav.connectEnd - nav.connectStart,
            requestStart: nav.requestStart,
            responseEnd: nav.responseEnd,
            transferSize: nav.transferSize ?? 0,
            encodedBodySize: nav.encodedBodySize ?? 0,
          };
          ttfb = nav.responseStart - nav.requestStart;
        }
        resolve({
          webVitals: {
            LCP: lcp,
            CLS: cls > 0 ? cls : null,
            INP: inp,
            FCP: fcp,
            TTFB: ttfb,
          },
          navigation: navOut,
        });
      }, ${params.waitMs});
    })`;

    // Race the evaluate against the abort signal so a cancel mid-wait
    // doesn't leave us blocked for waitMs.
    const evalPromise = session.evaluate<PerfResult>(expr, {
      awaitPromise: true,
      returnByValue: true,
      signal,
    });
    const result = await evalPromise;
    throwIfAborted(signal);

    const tabInfo = await chrome.tabs.get(tab.tabId).catch(() => null);
    return {
      tabId: tab.tabId,
      url: tabInfo?.url ?? params.url ?? '',
      webVitals: result.webVitals,
      navigation: result.navigation,
    };
  } finally {
    if (session && !tab.reused) {
      try {
        await session.detach();
      } catch {
        // already detached / debugger gone
      }
    }
    if (!tab.reused) await tab.cleanup();
  }
}

