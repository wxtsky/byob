import { GetCookiesInput } from '@byob/shared';
import { throwIfAborted } from '../signal-utils.js';
import { isHostAllowedByPolicy } from '../url-guard.js';

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
  // This handler never attaches the debugger, so the host policy enforced in
  // tryAttachToTab does not see it — and with no url/domain filter it would
  // otherwise hand back every cookie for every site, denied ones included.
  // Filtering per cookie covers the unfiltered call too.
  const allowed = raw.filter((c) => isHostAllowedByPolicy(c.domain));
  const withheldByPolicy = raw.length - allowed.length;
  const cookies = allowed.map((c) => ({
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
  return { cookies, ...(withheldByPolicy > 0 ? { withheldByPolicy } : {}) };
}
