import { GetCookiesInput } from '@byob/shared';
import { throwIfAborted } from '../signal-utils.js';

interface ChromeCookieWithPartition extends chrome.cookies.Cookie {
  partitionKey?: { topLevelSite?: string };
}

export async function handleGetCookies(
  rawParams: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const params = GetCookiesInput.parse(rawParams);
  throwIfAborted(signal);

  const filter: chrome.cookies.GetAllDetails = {};
  if (params.url) filter.url = params.url;
  if (params.domain) filter.domain = params.domain;

  const raw = (await chrome.cookies.getAll(filter)) as ChromeCookieWithPartition[];
  throwIfAborted(signal);
  const cookies = raw.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    expires: c.expirationDate,
    httpOnly: !!c.httpOnly,
    secure: !!c.secure,
    sameSite: c.sameSite,
    partitionKey: c.partitionKey?.topLevelSite,
  }));
  return { cookies };
}
