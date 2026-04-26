import { SetCookiesInput } from '@byob/shared';
import { throwIfAborted } from '../signal-utils.js';

interface ChromeCookieWithPartition extends chrome.cookies.Cookie {
  partitionKey?: { topLevelSite?: string };
}

export async function handleSetCookies(
  rawParams: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const params = SetCookiesInput.parse(rawParams);
  throwIfAborted(signal);

  const details: chrome.cookies.SetDetails = {
    url: params.url,
    name: params.name,
    value: params.value,
  };
  if (params.domain !== undefined) details.domain = params.domain;
  if (params.path !== undefined) details.path = params.path;
  if (params.secure !== undefined) details.secure = params.secure;
  if (params.httpOnly !== undefined) details.httpOnly = params.httpOnly;
  if (params.sameSite !== undefined) details.sameSite = params.sameSite;
  if (params.expirationDate !== undefined) details.expirationDate = params.expirationDate;
  if (params.partitionKey !== undefined) {
    (details as chrome.cookies.SetDetails & { partitionKey?: { topLevelSite: string } })
      .partitionKey = { topLevelSite: params.partitionKey };
  }

  const cookie = (await chrome.cookies.set(details)) as ChromeCookieWithPartition | null;
  throwIfAborted(signal);
  if (!cookie) {
    return {
      error: 'unknown',
      message: chrome.runtime.lastError?.message ?? 'chrome.cookies.set returned null',
    };
  }
  return {
    ok: true as const,
    cookie: {
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      expires: cookie.expirationDate,
      httpOnly: !!cookie.httpOnly,
      secure: !!cookie.secure,
      sameSite: cookie.sameSite,
      partitionKey: cookie.partitionKey?.topLevelSite,
    },
  };
}
