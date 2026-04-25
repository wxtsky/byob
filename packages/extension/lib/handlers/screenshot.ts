import { ScreenshotInput } from '@byob/shared';
import { tryAttachToTab } from '../cdp.js';
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

  const { session, reason } = await tryAttachToTab(tab.tabId, signal);
  if (!session) {
    if (!tab.reused) await tab.cleanup();
    if (reason === 'special_page') {
      return {
        error: 'url_forbidden',
        message: 'Cannot screenshot special pages (chrome://, devtools://, etc.).',
        hint: 'Pass a regular http(s):// url, or switch to a non-special tab.',
      };
    }
    if (reason === 'tab_gone') {
      return { error: 'tab_closed', message: 'Tab was closed before screenshot could attach.' };
    }
    return {
      error: 'cdp_attach_failed',
      message: 'Could not attach Chrome debugger after 3 retries.',
      hint: 'Close DevTools (F12) on the target tab and retry.',
    };
  }

  keepAwakeStart();
  try {
    const cdpParams: Record<string, unknown> = {
      format: params.format,
      captureBeyondViewport: params.fullPage,
    };
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
        message: `screenshot too large (base64 ${result.data.length}). Try fullPage:false or format:jpeg + quality:60.`,
      };
    }

    // Read viewport for the response payload.
    const dims = await session.evaluate<{ w: number; h: number }>(
      `(() => ({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight }))()`,
      { awaitPromise: false, signal },
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
