import { DownloadImagesInput } from '@byob/shared';
import { tryAttachToTab } from '../cdp.js';
import { openOrReuse } from '../tab.js';
import { checkUrlAllowed, urlForbiddenError } from '../url-guard.js';
import { keepAwakeStart, keepAwakeEnd } from '../keepalive.js';
import {
  resolveFrame,
  evaluateInResolvedFrame,
  frameErrorToEnvelope,
} from '../frame-resolver.js';
import { isAbortError, sleepWithSignal, throwIfAborted } from '../signal-utils.js';

const COLLECTOR_INSTALL = `
(() => {
  if (window.__byobCollectImages) return;

  // Visibility spoof so background tabs trigger lazy IntersectionObserver loaders
  try {
    Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get: () => 'visible' });
    Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  } catch (_) {}

  window.__byobCollectImages = function(opts) {
    const includeOg = !!opts.includeOgImage;
    const minW = opts.minWidth | 0;
    const minH = opts.minHeight | 0;
    const out = [];
    const seen = new Set();

    // <img> tags
    for (const el of document.querySelectorAll('img')) {
      const src = el.currentSrc || el.src || (el.dataset && el.dataset.src) || '';
      if (!src) continue;
      let abs;
      try { abs = new URL(src, location.href).href; } catch { continue; }
      if (abs.startsWith('data:')) continue;
      if (seen.has(abs)) continue;
      const w = el.naturalWidth || el.width || 0;
      const h = el.naturalHeight || el.height || 0;
      if (w && w < minW) continue;
      if (h && h < minH) continue;
      seen.add(abs);
      const r = el.getBoundingClientRect();
      out.push({
        sourceUrl: abs,
        width: w || undefined,
        height: h || undefined,
        bounds: [Math.round(r.x + window.scrollX), Math.round(r.y + window.scrollY), Math.round(r.width), Math.round(r.height)],
        alt: el.alt || undefined,
      });
    }

    // og:image / twitter:image fallbacks (size unknown — never filtered out)
    if (includeOg) {
      const metaSels = [
        'meta[property="og:image"]',
        'meta[property="og:image:url"]',
        'meta[property="og:image:secure_url"]',
        'meta[name="twitter:image"]',
        'meta[name="twitter:image:src"]',
      ];
      for (const sel of metaSels) {
        const el = document.head && document.head.querySelector(sel);
        const c = el && el.getAttribute('content');
        if (!c) continue;
        let abs;
        try { abs = new URL(c, location.href).href; } catch { continue; }
        if (abs.startsWith('data:')) continue;
        if (seen.has(abs)) continue;
        seen.add(abs);
        out.push({ sourceUrl: abs, source: 'og' });
      }
    }
    return out;
  };

  window.__byobScrollOnceForImages = function() {
    window.scrollBy({ top: window.innerHeight, behavior: 'instant' });
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => { if (settled) return; settled = true; obs.disconnect(); clearTimeout(t); resolve(); };
      const obs = new MutationObserver(() => { clearTimeout(quiet); quiet = setTimeout(finish, 300); });
      obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src','srcset','data-src'] });
      let quiet = setTimeout(finish, 300);
      const t = setTimeout(finish, 1800);
    });
  };
})();
`;

interface CollectedCandidate {
  sourceUrl: string;
  width?: number;
  height?: number;
  bounds?: [number, number, number, number];
  alt?: string;
  source?: 'og';
}

export async function handleDownloadImages(
  rawParams: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const params = DownloadImagesInput.parse(rawParams);
  // bridge enriches the params with these two fields before forwarding
  const extra = rawParams as { uploadEndpoint?: string; uploadSecret?: string };
  const uploadEndpoint = typeof extra.uploadEndpoint === 'string' ? extra.uploadEndpoint : '';
  const uploadSecret = typeof extra.uploadSecret === 'string' ? extra.uploadSecret : '';
  if (!uploadEndpoint || !uploadSecret) {
    return { error: 'unknown', message: 'bridge did not provide uploadEndpoint/uploadSecret' };
  }

  const guard = checkUrlAllowed(params.url);
  if (!guard.ok) return urlForbiddenError(guard.reason);
  throwIfAborted(signal);

  const tab = await openOrReuse({
    url: params.url,
    reuseActive: params.reuseTab,
    signal,
  });

  const { session, reason } = await tryAttachToTab(tab.tabId, signal);
  if (!session) {
    if (!tab.reused) await tab.cleanup();
    if (reason === 'special_page') {
      return {
        error: 'url_forbidden',
        message: 'Cannot operate on special pages (chrome://, devtools://, etc.).',
        hint: 'Use a regular http(s):// URL.',
      };
    }
    if (reason === 'tab_gone') {
      return { error: 'tab_closed', message: 'Tab was closed before download could attach.' };
    }
    return {
      error: 'cdp_attach_failed',
      message: 'Could not attach Chrome debugger after 3 retries.',
      hint: 'Close DevTools (F12) on the target tab and retry.',
    };
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

  keepAwakeStart();
  try {
    await evaluateInResolvedFrame(session, frame, COLLECTOR_INSTALL, {
      awaitPromise: false,
      signal,
    });

    // Prime + scroll N screens to trigger lazy loaders
    if (params.screens > 0) {
      await evaluateInResolvedFrame(session, frame, 'window.scrollTo(0, 0)', {
        awaitPromise: false,
        signal,
      });
      await sleepWithSignal(200, signal);
      for (let i = 0; i < params.screens; i++) {
        throwIfAborted(signal);
        await evaluateInResolvedFrame(session, frame, 'window.__byobScrollOnceForImages()', {
          awaitPromise: true,
          signal,
        });
      }
      await evaluateInResolvedFrame(session, frame, 'window.scrollTo(0, 0)', {
        awaitPromise: false,
        signal,
      });
    }

    // Collect candidates
    // NB: bounds in `images[]` are viewport-relative to the resolved frame,
    // not the top page. For top-level use (framePath:[]) this matches v0.1.
    const candidates = await evaluateInResolvedFrame<CollectedCandidate[]>(
      session,
      frame,
      `window.__byobCollectImages(${JSON.stringify({
        includeOgImage: params.includeOgImage,
        minWidth: params.minWidth,
        minHeight: params.minHeight,
      })})`,
      { awaitPromise: false, signal },
    );

    const limited = (candidates ?? []).slice(0, params.maxImages);

    // Fetch + upload from the service worker context — page CSP would
    // otherwise block fetch() to 127.0.0.1 (Apple etc. lock connect-src
    // tight). The extension has <all_urls> host permission so SW fetch
    // sends cookies automatically.
    type UploadResult = CollectedCandidate & {
      ok: boolean;
      path?: string;
      size?: number;
      contentType?: string;
      error?: string;
    };
    const results: UploadResult[] = [];
    for (let i = 0; i < limited.length; i++) {
      throwIfAborted(signal);
      const item = limited[i]!;
      try {
        const resp = await fetch(item.sourceUrl, { credentials: 'include', signal });
        if (!resp.ok) {
          results.push({ ...item, ok: false, error: `fetch ${resp.status}` });
          continue;
        }
        const buf = await resp.arrayBuffer();
        const ct = resp.headers.get('content-type') ?? '';
        let filename = (item.sourceUrl.split('?')[0] || '').split('/').pop() || `image-${i}`;
        if (!/\.[a-zA-Z0-9]{2,5}$/.test(filename)) {
          const ext = ct.includes('jpeg')
            ? 'jpg'
            : ct.includes('png')
              ? 'png'
              : ct.includes('webp')
                ? 'webp'
                : ct.includes('gif')
                  ? 'gif'
                  : ct.includes('svg')
                    ? 'svg'
                    : 'bin';
          filename = filename + '.' + ext;
        }
        const uploadUrl =
          uploadEndpoint +
          '?index=' +
          i +
          '&filename=' +
          encodeURIComponent(filename);
        // Secret moved from ?secret= query to Authorization: Bearer so it
        // doesn't leak into bridge access logs / DevTools URL display. The
        // bridge still accepts the legacy query form for older builds.
        const r = await fetch(uploadUrl, {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + uploadSecret },
          body: buf,
          signal,
        });
        const j = (await r.json()) as { ok: boolean; path?: string; size?: number; error?: string };
        if (j.ok) {
          results.push({
            ...item,
            ok: true,
            path: j.path,
            size: j.size,
            contentType: ct || undefined,
          });
        } else {
          results.push({ ...item, ok: false, error: j.error ?? 'upload failed' });
        }
      } catch (e) {
        // Abort during fetch: propagate to dispatcher, don't bury in results.
        if (isAbortError(e)) throw e;
        results.push({
          ...item,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    const tabInfo = await chrome.tabs.get(tab.tabId);
    const dims = await evaluateInResolvedFrame<{ w: number; h: number }>(
      session,
      frame,
      '({ w: window.innerWidth, h: window.innerHeight })',
      { awaitPromise: false, signal },
    );

    const ok = (results ?? []).filter((r) => r.ok && r.path);
    const skipped = (results ?? []).length - ok.length + Math.max(0, (candidates?.length ?? 0) - limited.length);

    return {
      page: {
        url: tabInfo.url ?? params.url,
        title: tabInfo.title ?? '',
        viewport: { width: dims?.w ?? 0, height: dims?.h ?? 0 },
      },
      images: ok.map((r) => ({
        path: r.path!,
        sourceUrl: r.sourceUrl,
        // r.path comes back from the bridge upload server already disk-side
        // joined: posix uses '/', win32 uses '\'. Split on both so the
        // filename field doesn't degenerate into the full absolute path
        // (which is what plain split('/') would do on Windows).
        filename: (r.path ?? '').split(/[\\/]/).pop() ?? '',
        size: r.size ?? 0,
        width: r.width,
        height: r.height,
        contentType: r.contentType,
        bounds: r.bounds,
        alt: r.alt,
      })),
      skipped,
    };
  } finally {
    keepAwakeEnd();
    if (!tab.reused) {
      await session.detach();
      await tab.cleanup();
    }
  }
}
