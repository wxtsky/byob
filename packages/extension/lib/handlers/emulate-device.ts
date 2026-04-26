import { EmulateDeviceInput } from '@byob/shared';
import { tryAttachToTab } from '../cdp.js';
import { openOrReuse } from '../tab.js';
import { checkUrlAllowed, urlForbiddenError } from '../url-guard.js';
import { throwIfAborted } from '../signal-utils.js';

interface DeviceMetrics {
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
  userAgent: string;
}

// PRESETS values researched from public manufacturer spec pages on 2026-04-27.
// Each entry's source URL + retrieval date is in the comment above it.
//
// CSS viewport = hardware pixels / deviceScaleFactor (portrait orientation).
// UA strings: Safari iOS/iPadOS reports frozen OS 18_6 per Apple's UA-reduction
// policy (Version/ reflects Safari 26 as of 2026-04-27); Chrome Android uses
// generic Pixel 9 Pro template with Chrome 136 (latest stable April 2026).
const PRESETS: Record<
  'iphone-17-pro-max' | 'iphone-17' | 'ipad-pro' | 'pixel-9-pro' | 'galaxy-s25-ultra',
  DeviceMetrics
> = {
  'iphone-17-pro-max': {
    // iPhone 17 Pro Max: https://www.webmobilefirst.com/en/devices/apple-iphone-17-pro-max-2025/ (retrieved 2026-04-27)
    // Hardware 1320×2868, DPR 3 → CSS 440×956. Confirmed by https://www.ios-resolution.com/iphone-17-pro-max/ (retrieved 2026-04-27)
    width: 440,
    height: 956,
    deviceScaleFactor: 3,
    mobile: true,
    userAgent:
      // Safari iOS 26 frozen-UA per https://nielsleenheer.com/articles/2025/the-user-agent-string-of-safari-on-ios-26-and-macos-26/ (retrieved 2026-04-27)
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
  },
  'iphone-17': {
    // iPhone 17: https://www.webmobilefirst.com/en/devices/apple-iphone-17-2025/ (retrieved 2026-04-27)
    // Hardware 1206×2622, DPR 3 → CSS 402×874.
    width: 402,
    height: 874,
    deviceScaleFactor: 3,
    mobile: true,
    userAgent:
      // Safari iOS 26 frozen-UA per https://nielsleenheer.com/articles/2025/the-user-agent-string-of-safari-on-ios-26-and-macos-26/ (retrieved 2026-04-27)
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
  },
  'ipad-pro': {
    // iPad Pro M4 13": https://support.kioskgroup.com/article/660-determining-screen-dimensions-for-content (retrieved 2026-04-27)
    // Hardware 2752×2064, DPR 2 → CSS 1376×1032 landscape / 1032×1376 portrait. Using portrait (width=1032, height=1376).
    width: 1032,
    height: 1376,
    deviceScaleFactor: 2,
    mobile: true,
    userAgent:
      // iPadOS Safari 26 frozen-UA per https://nielsleenheer.com/articles/2025/the-user-agent-string-of-safari-on-ios-26-and-macos-26/ (retrieved 2026-04-27)
      'Mozilla/5.0 (iPad; CPU OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
  },
  'pixel-9-pro': {
    // Pixel 9 Pro: https://phone-simulator.com/devices/google-pixel-9-pro (retrieved 2026-04-27)
    // Hardware 1280×2856, DPR 3 → CSS 427×952. Confirmed by physical resolution cross-check.
    width: 427,
    height: 952,
    deviceScaleFactor: 3,
    mobile: true,
    userAgent:
      // Chrome 136 Android template per https://www.useragents.me/ + https://www.whatismybrowser.com/guides/the-latest-user-agent/chrome (retrieved 2026-04-27)
      'Mozilla/5.0 (Linux; Android 14; Pixel 9 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Mobile Safari/537.36',
  },
  'galaxy-s25-ultra': {
    // Galaxy S25 Ultra: https://phone-simulator.com/devices/samsung-galaxy-s25-ultra (retrieved 2026-04-27)
    // Hardware 1440×3120, DPR 3 → CSS 480×1040. Confirmed by https://www.webmobilefirst.com (retrieved 2026-04-27).
    width: 480,
    height: 1040,
    deviceScaleFactor: 3,
    mobile: true,
    userAgent:
      // Chrome 136 Android template; SM-S938B is Galaxy S25 Ultra model number per Samsung (retrieved 2026-04-27)
      'Mozilla/5.0 (Linux; Android 15; SM-S938B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Mobile Safari/537.36',
  },
};

export async function handleEmulateDevice(
  rawParams: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const params = EmulateDeviceInput.parse(rawParams);
  if (params.url) {
    const guard = checkUrlAllowed(params.url);
    if (!guard.ok) return urlForbiddenError(guard.reason);
  }
  throwIfAborted(signal);

  const tab = await openOrReuse({ url: params.url, tabId: params.tabId, signal });
  const { session, reason } = await tryAttachToTab(tab.tabId, signal);
  if (!session) {
    if (!tab.reused) await tab.cleanup();
    return attachErrorToEnvelope(reason);
  }

  // Desktop reset path
  if (params.preset === 'desktop') {
    await session.send('Emulation.clearDeviceMetricsOverride', {}, signal);
    await session.send('Emulation.setUserAgentOverride', { userAgent: '' }, signal);
    await session.send('Emulation.setTouchEmulationEnabled', { enabled: false }, signal);
    const tabInfo = await chrome.tabs.get(tab.tabId).catch(() => null);
    return {
      tabId: tab.tabId,
      url: tabInfo?.url ?? params.url ?? '',
      applied: null,
    };
  }

  // Resolve metrics from preset or custom
  let metrics: DeviceMetrics;
  if (params.preset) {
    metrics = PRESETS[params.preset as keyof typeof PRESETS];
  } else {
    const c = params.custom!;
    metrics = {
      width: c.width,
      height: c.height,
      deviceScaleFactor: c.deviceScaleFactor,
      mobile: c.mobile,
      userAgent: c.userAgent ?? '',
    };
  }

  await session.send(
    'Emulation.setDeviceMetricsOverride',
    {
      width: metrics.width,
      height: metrics.height,
      deviceScaleFactor: metrics.deviceScaleFactor,
      mobile: metrics.mobile,
    },
    signal,
  );
  if (metrics.userAgent) {
    await session.send('Emulation.setUserAgentOverride', { userAgent: metrics.userAgent }, signal);
  } else {
    // No UA override — leave Chrome's default UA active. Best-effort clear of any prior override.
    await session.send('Emulation.setUserAgentOverride', { userAgent: '' }, signal);
  }
  await session.send('Emulation.setTouchEmulationEnabled', { enabled: metrics.mobile }, signal);

  const tabInfo = await chrome.tabs.get(tab.tabId).catch(() => null);
  return {
    tabId: tab.tabId,
    url: tabInfo?.url ?? params.url ?? '',
    applied: metrics,
  };
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
