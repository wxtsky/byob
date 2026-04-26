import { GetPerformanceInput } from '@byob/shared';
import { tryAttachToTab } from '../cdp.js';
import { openOrReuse } from '../tab.js';
import { checkUrlAllowed, urlForbiddenError } from '../url-guard.js';
import { throwIfAborted } from '../signal-utils.js';

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

  try {
    const { session, reason } = await tryAttachToTab(tab.tabId, signal);
    if (!session) return attachErrorToEnvelope(reason);

    const expr = `new Promise((resolve) => {
      let lcp = null, cls = 0, inp = null, fcp = null;
      try {
        new PerformanceObserver((list) => {
          const e = list.getEntries();
          const last = e[e.length - 1];
          if (last) lcp = last.renderTime || last.loadTime || last.startTime;
        }).observe({ type: 'largest-contentful-paint', buffered: true });
      } catch (_) {}
      try {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (!entry.hadRecentInput) cls += entry.value;
          }
        }).observe({ type: 'layout-shift', buffered: true });
      } catch (_) {}
      try {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (entry.duration > (inp ?? 0)) inp = entry.duration;
          }
        }).observe({ type: 'event', buffered: true, durationThreshold: 40 });
      } catch (_) {}
      try {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (entry.name === 'first-contentful-paint') fcp = entry.startTime;
          }
        }).observe({ type: 'paint', buffered: true });
      } catch (_) {}
      setTimeout(() => {
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
    if (!tab.reused) await tab.cleanup();
  }
}

function attachErrorToEnvelope(
  reason?: 'special_page' | 'tab_gone' | 'attach_failed',
): { error: string; message: string; hint?: string } {
  if (reason === 'special_page') {
    return {
      error: 'url_forbidden',
      message: 'Tab is on a special page (chrome://, devtools://, etc.) — CDP cannot attach.',
      hint: 'Switch to a regular http(s):// tab.',
    };
  }
  if (reason === 'tab_gone') return { error: 'tab_closed', message: 'Tab was closed.' };
  return {
    error: 'cdp_attach_failed',
    message: 'Could not attach Chrome debugger after 3 retries.',
    hint: 'Close DevTools (F12) on the target tab and retry.',
  };
}
