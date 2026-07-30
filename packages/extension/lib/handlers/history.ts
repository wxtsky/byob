import { HistoryInput } from '@byob/shared';
import { throwIfAborted } from '../signal-utils.js';
import { checkUrlAllowed } from '../url-guard.js';

export async function handleHistory(
  rawParams: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const params = HistoryInput.parse(rawParams);
  throwIfAborted(signal);

  const query: chrome.history.HistoryQuery = {
    text: params.queries.join(' '),
    maxResults: params.limit,
    startTime: params.from ? Date.parse(params.from) : 0,
  };
  if (params.to) query.endTime = Date.parse(params.to);

  const results = await chrome.history.search(query);
  throwIfAborted(signal);

  let hiddenByPolicy = 0;
  const entries: Array<{ dateVisited: string; title?: string; url: string }> = [];
  for (const item of results) {
    if (!item.url || item.lastVisitTime === undefined) continue;
    const access = checkUrlAllowed(item.url);
    if (!access.ok) {
      hiddenByPolicy++;
      continue;
    }
    const entry: { dateVisited: string; title?: string; url: string } = {
      dateVisited: new Date(item.lastVisitTime).toISOString(),
      url: item.url,
    };
    if (item.title) entry.title = item.title;
    entries.push(entry);
  }

  return {
    entries,
    ...(hiddenByPolicy > 0 ? { hiddenByPolicy } : {}),
  };
}
