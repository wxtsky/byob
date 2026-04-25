import { ScreenshotInput } from '@byob/shared';
import { attachToTab } from '../cdp.js';
import { openOrReuse } from '../tab.js';

const MAX_B64_LEN = 800_000; // ~600 KB PNG limit (NM frame budget)

export async function handleScreenshot(rawParams: unknown): Promise<unknown> {
  const params = ScreenshotInput.parse(rawParams);

  const tab = await openOrReuse({
    url: params.url,
    tabId: params.tabId,
    reuseActive: !params.url && params.tabId === undefined,
  });

  const session = await attachToTab(tab.tabId);
  if (!session) {
    if (!tab.reused) await tab.cleanup();
    return {
      error: 'cdp_attach_failed',
      message: 'Could not attach Chrome debugger.',
      hint: 'Close DevTools (F12) on the target tab and retry.',
    };
  }

  try {
    const cdpParams: Record<string, unknown> = {
      format: params.format,
      captureBeyondViewport: params.fullPage,
    };
    if (params.format === 'jpeg' && params.quality !== undefined) {
      cdpParams.quality = params.quality;
    }

    const result = await session.send<{ data: string }>('Page.captureScreenshot', cdpParams);
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
      { awaitPromise: false },
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
    if (!tab.reused) {
      await session.detach();
      await tab.cleanup();
    }
  }
}
