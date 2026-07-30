import { ScreenshotInput } from '@byob/shared';
import { tryAttachToTab } from '../cdp.js';
import { attachErrorEnvelope } from '../attach-error.js';
import { openOrReuse } from '../tab.js';
import { keepAwakeStart, keepAwakeEnd } from '../keepalive.js';
import { throwIfAborted } from '../signal-utils.js';

const MAX_B64_LEN = 800_000; // ~600 KB PNG limit (NM frame budget)

export async function handleScreenshot(
  rawParams: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const params = ScreenshotInput.parse(rawParams);
  throwIfAborted(signal);

  const tab = await openOrReuse({
    url: params.url,
    tabId: params.tabId,
    reuseActive: !params.url && params.tabId === undefined,
    signal,
  });

  const attachResult = await tryAttachToTab(tab.tabId, signal);
  const { session } = attachResult;
  if (!session) {
    if (!tab.reused) await tab.cleanup();
    return attachErrorEnvelope(attachResult, { what: 'screenshot' });
  }

  keepAwakeStart();
  try {
    const cdpParams: Record<string, unknown> = {
      format: params.format,
      captureBeyondViewport: params.clip ? false : params.fullPage,
    };
    if (params.clip) cdpParams.clip = { ...params.clip, scale: 1 };
    if (params.format === 'jpeg' && params.quality !== undefined) {
      cdpParams.quality = params.quality;
    }

    const result = await session.send<{ data: string }>(
      'Page.captureScreenshot',
      cdpParams,
      signal,
    );
    if (!result.data) return { error: 'unknown', message: 'CDP returned no data' };
    if (result.data.length > MAX_B64_LEN) {
      return {
        error: 'unknown',
        message: `screenshot too large (base64 ${result.data.length}). Try fullPage:false, format:jpeg + quality:60, or call browser_emulate_device first to shrink the viewport.`,
      };
    }

    // Report dimensions that match the captured PNG/JPEG. CDP captures the
    // viewport when captureBeyondViewport=false, and the full scroll area
    // when true — measure accordingly so the reported width/height equal the
    // image file's actual pixel dimensions (modulo deviceScaleFactor, which
    // CDP applies on top of these CSS pixels).
    const dims = params.clip
      ? { w: params.clip.width, h: params.clip.height }
      : await session.evaluate<{ w: number; h: number }>(
          params.fullPage
            ? `(() => ({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight }))()`
            : `(() => ({ w: window.innerWidth, h: window.innerHeight }))()`,
          {
            awaitPromise: false,
            signal,
          },
        );

    return {
      _b64Data: result.data,
      _format: params.format,
      _savePath: params.savePath,
      width: dims.w,
      height: dims.h,
      format: params.format,
    };
  } finally {
    keepAwakeEnd();
    if (!tab.reused) {
      await session.detach();
      await tab.cleanup();
    }
  }
}
