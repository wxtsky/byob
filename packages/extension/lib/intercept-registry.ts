import type { CdpSession } from './cdp.js';

export type InterceptEndedReason = 'user_stop' | 'tab_closed' | 'wake_recovery';

/**
 * One rule, pre-compiled at start time.
 * - regex: derived from urlPattern (glob → regex) or urlRegex (RegExp source)
 * - methodSet: lower-cased Set, undefined means "any method"
 * - rest: passed verbatim from the input rule
 */
export interface CompiledRule {
  regex: RegExp;
  methodSet?: Set<string>;
  action: 'block' | 'fulfill' | 'modify' | 'modifyResponse' | 'passthrough';
  // Action sub-objects (only the one matching `action` is read at apply time):
  block?: { errorReason?: string };
  fulfill?: {
    status?: number;
    headers?: Record<string, string>;
    body?: string;
    bodyBase64?: string;
  };
  modify?: {
    requestHeaders?: Record<string, string>;
    url?: string;
    method?: string;
  };
  modifyResponse?: {
    responseStatus?: number;
    responseHeaders?: Record<string, string>;
    bodyReplace?: string;
    bodyRegex?: { pattern: string; replacement: string; flags?: string };
  };
}

export interface InterceptEntry {
  interceptId: string;
  tabId: number;
  session: CdpSession;
  rules: CompiledRule[];
  /** hits[i] = times rules[i] matched */
  hits: number[];
  /** sampleUrls[i] = up to 3 URLs that hit rules[i] */
  sampleUrls: string[][];
  /** Total Fetch.requestPaused events seen (incl. unmatched passthrough). */
  totalRequests: number;
  startedAt: number;
  state: 'intercepting' | 'ended';
  endedReason?: InterceptEndedReason;
  endedAt?: number;
  /** Cleanup functions installed by intercept-start (CDP listener + tab onRemoved). */
  listenerCleanups: Array<() => void>;
  tabRemovedListener: ((tabId: number) => void) | null;
  /**
   * True iff this entry currently holds a +1 keepalive ref.
   * Set by intercept-start via keepAwakeStart(); cleared by intercept-stop
   * via keepAwakeEnd(). See packages/extension/lib/keepalive.ts.
   */
  keepaliveHeld: boolean;
}

const registry = new Map<string, InterceptEntry>();

const KEEPALIVE_ALARM_NAME = 'byob-intercept-tick';
const ENDED_ENTRY_GC_TTL_MS = 5 * 60 * 1000; // 5 min — drained intercepts are stop-driven, not auto-stopped

export function getRegistry(): Map<string, InterceptEntry> {
  return registry;
}

export function addIntercept(entry: InterceptEntry): void {
  registry.set(entry.interceptId, entry);
  ensureKeepaliveTick();
}

export function getIntercept(id: string): InterceptEntry | undefined {
  return registry.get(id);
}

export function deleteIntercept(id: string): void {
  registry.delete(id);
  if (countActive() === 0) clearKeepaliveTick();
}

export function countActive(): number {
  let n = 0;
  for (const e of registry.values()) if (e.state === 'intercepting') n++;
  return n;
}

/**
 * Mark an entry as ended without removing it. The next stop call drains it.
 * Used by tab-close / wake-recovery hooks installed by intercept-start.
 */
export function markEnded(id: string, reason: InterceptEndedReason): void {
  const e = registry.get(id);
  if (!e) return;
  if (e.state === 'ended') return;
  e.state = 'ended';
  e.endedReason = reason;
  e.endedAt = Date.now();
  // Best-effort cleanup of CDP listeners; the actual Fetch.disable happens
  // in stop or when the tab CDP detaches.
  for (const cleanup of e.listenerCleanups) {
    try {
      cleanup();
    } catch {
      // ignore
    }
  }
  e.listenerCleanups = [];
  if (e.tabRemovedListener) {
    try {
      chrome.tabs.onRemoved.removeListener(e.tabRemovedListener);
    } catch {
      // ignore
    }
    e.tabRemovedListener = null;
  }
}

/**
 * Install a 25 s no-op chrome.alarms tick. Belt-and-suspenders against MV3
 * SW eviction during long intercept sessions. Idempotent — installs at most
 * one alarm regardless of how many concurrent intercepts exist.
 */
function ensureKeepaliveTick(): void {
  chrome.alarms.get(KEEPALIVE_ALARM_NAME, (existing) => {
    if (!existing) {
      chrome.alarms.create(KEEPALIVE_ALARM_NAME, { periodInMinutes: 0.4 });
    }
  });
}

function clearKeepaliveTick(): void {
  chrome.alarms.clear(KEEPALIVE_ALARM_NAME).catch(() => {
    // ignore — alarm may not exist
  });
}

/**
 * GC ended entries that have been sitting around without being drained by
 * intercept-stop. Run from the keepalive alarm tick.
 */
export function gcEndedEntries(now: number): void {
  for (const [id, e] of registry) {
    if (e.state !== 'ended') continue;
    if (e.endedAt === undefined) continue;
    if (now - e.endedAt > ENDED_ENTRY_GC_TTL_MS) {
      registry.delete(id);
    }
  }
  if (countActive() === 0 && registry.size === 0) clearKeepaliveTick();
}

// Named listener + hasListener guard so dev hot-reload / re-import doesn't
// stack duplicates of the keepalive-alarm handler.
function onInterceptAlarm(alarm: chrome.alarms.Alarm): void {
  if (alarm.name === KEEPALIVE_ALARM_NAME) {
    gcEndedEntries(Date.now());
  }
}
if (!chrome.alarms.onAlarm.hasListener?.(onInterceptAlarm)) {
  chrome.alarms.onAlarm.addListener(onInterceptAlarm);
}
