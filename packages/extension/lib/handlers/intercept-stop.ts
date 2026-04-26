import { InterceptStopInput } from '@byob/shared';
import { throwIfAborted } from '../signal-utils.js';
import { keepAwakeEnd } from '../keepalive.js';
import { getIntercept, deleteIntercept, markEnded } from '../intercept-registry.js';

export async function handleInterceptStop(
  rawParams: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const params = InterceptStopInput.parse(rawParams);
  throwIfAborted(signal);

  const entry = getIntercept(params.interceptId);
  if (!entry) {
    return {
      error: 'intercept_not_found',
      message: `interceptId ${params.interceptId} not found (already stopped or unknown)`,
    };
  }

  // If the entry is still active, mark it ended (user_stop) which also runs
  // listenerCleanups + tabRemovedListener cleanup. Then disable Fetch domain.
  if (entry.state === 'intercepting') {
    markEnded(entry.interceptId, 'user_stop');
    try {
      await entry.session.send('Fetch.disable', {}, signal);
    } catch {
      // session may already be detached (sleep/wake/tab close)
    }
  }

  // KEEPALIVE: release the +1 ref that intercept-start grabbed.
  // tab-close path already releases its own ref before calling markEnded,
  // so this is a no-op in that case (keepaliveHeld is already false).
  if (entry.keepaliveHeld) {
    keepAwakeEnd();
    entry.keepaliveHeld = false;
  }

  const durationMs = (entry.endedAt ?? Date.now()) - entry.startedAt;
  const hitsByRule = entry.hits.map((count, i) => ({
    ruleIndex: i,
    count,
    sampleUrls: entry.sampleUrls[i] ?? [],
  }));
  const endedReason = entry.endedReason ?? 'user_stop';

  // Remove from registry now that we've drained the stats.
  deleteIntercept(entry.interceptId);

  return {
    interceptId: entry.interceptId,
    tabId: entry.tabId,
    totalRequests: entry.totalRequests,
    hitsByRule,
    durationMs,
    endedReason,
  };
}
