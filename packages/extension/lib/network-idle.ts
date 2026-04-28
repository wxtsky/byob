/**
 * "Real" networkidle wait via PerformanceObserver injected with
 * chrome.scripting.executeScript — no CDP attach required.
 *
 * Why this rather than Page.lifecycleEvent('networkidle')? attach() shows
 * the yellow "this tab is being debugged" bar, which we don't want for a
 * pure navigation. PerformanceObserver gives us the same signal (resource
 * timing entries) without any visible side effect.
 *
 * Calibration: a 500 ms quiet window gives a stable signal across most
 * pages. Ad / analytics / heartbeat domains are filtered so persistent
 * background pings don't keep the wait alive forever. browser-use's
 * `dom_watchdog` uses essentially the same list.
 */

// Match against URL substrings. Each entry is intentionally specific
// enough to avoid false positives on legitimate user APIs hosted on the
// same parent domain (e.g. an app's own *.sentry.io subdomain). When in
// doubt, prefer the analytics ingestion subdomain over the bare apex.
const AD_DOMAINS = [
  'doubleclick.net',
  'googlesyndication.com',
  'google-analytics.com',
  'googletagmanager.com',
  'googleadservices.com',
  'analytics.tiktok.com',
  'facebook.com/tr',
  'connect.facebook.net',
  'pixel.facebook.com',
  'static.hotjar.com',
  'script.hotjar.com',
  'fullstory.com/s/fs.js',
  'cdn.segment.com',
  'api.segment.io/v1',
  'cdn.amplitude.com',
  'api.amplitude.com',
  'api2.amplitude.com',
  'api.mixpanel.com',
  'cdn.mxpnl.com',
  'ingest.sentry.io',
  'bam.nr-data.net',
  'bam-cell.nr-data.net',
  'js-agent.newrelic.com',
  'scorecardresearch.com',
  'cdn.optimizely.com',
  'logx.optimizely.com',
];

const QUIET_WINDOW_MS = 500;
const DEFAULT_MAX_WAIT_MS = 10_000;

interface IdleResult {
  ok: boolean;
  reason?: 'timeout';
  durationMs: number;
  resourceCount: number;
}

/**
 * Block until the page goes quiet (no new resource timing entries for
 * QUIET_WINDOW_MS) or maxWaitMs elapses. Resolves either way; the caller
 * gets a flag in the result. Aborting the signal makes us stop polling
 * and resolve with whatever we have so far.
 */
export async function waitForNetworkIdle(
  tabId: number,
  maxWaitMs: number = DEFAULT_MAX_WAIT_MS,
  signal?: AbortSignal,
): Promise<IdleResult> {
  if (signal?.aborted) {
    return { ok: false, reason: 'timeout', durationMs: 0, resourceCount: 0 };
  }

  // Run the observer in the page; it self-resolves when quiet.
  // chrome.scripting.executeScript awaits returned Promises in MV3.
  const inject = (
    adDomains: string[],
    quietWindowMs: number,
    maxMs: number,
  ): Promise<IdleResult> => {
    return new Promise<IdleResult>((resolve) => {
      const start = performance.now();
      let lastChange = start;
      let resourceCount = 0;
      let stopped = false;

      const isAd = (url: string): boolean => {
        for (const d of adDomains) {
          if (url.includes(d)) return true;
        }
        return false;
      };

      // The lib.webworker types this ts file is checked against don't know
      // PerformanceObserver's page-side callback signature, but this entire
      // function body is shipped to the page via chrome.scripting where the
      // real DOM types apply. Use @ts-ignore (not @ts-expect-error) so the
      // suppression doesn't itself become a "no error to expect" warning
      // when ts-lib is upgraded.
      let observer: PerformanceObserver | null = null;
      try {
        // @ts-ignore page-context PerformanceObserver
        observer = new PerformanceObserver((list: { getEntries(): Array<{ name: string }> }) => {
          for (const e of list.getEntries()) {
            if (isAd(e.name)) continue;
            resourceCount += 1;
            lastChange = performance.now();
          }
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        observer?.observe({ type: 'resource', buffered: true } as any);
      } catch {
        // Some browsers throw if observe is called before the page is ready;
        // fall back to a simple delay loop.
      }

      const finish = (ok: boolean, reason?: 'timeout'): void => {
        if (stopped) return;
        stopped = true;
        try {
          observer?.disconnect();
        } catch {
          /* ignore */
        }
        const result: IdleResult = {
          ok,
          durationMs: performance.now() - start,
          resourceCount,
        };
        if (reason) result.reason = reason;
        resolve(result);
      };

      const tick = (): void => {
        if (stopped) return;
        const now = performance.now();
        if (now - start > maxMs) {
          finish(false, 'timeout');
          return;
        }
        if (now - lastChange > quietWindowMs) {
          finish(true);
          return;
        }
        setTimeout(tick, 100);
      };
      // Wait at least quietWindowMs before the first eligibility check so
      // we don't insta-resolve on a page that's about to start fetching.
      setTimeout(tick, quietWindowMs);
    });
  };

  try {
    const [exec] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: inject,
      args: [AD_DOMAINS, QUIET_WINDOW_MS, maxWaitMs],
    });
    const result = exec?.result as IdleResult | undefined;
    return result ?? { ok: false, reason: 'timeout', durationMs: 0, resourceCount: 0 };
  } catch {
    // executeScript can fail on special pages (chrome://, about:blank etc.).
    // Treat as "we don't know, assume idle" rather than blocking.
    return { ok: true, durationMs: 0, resourceCount: 0 };
  }
}
