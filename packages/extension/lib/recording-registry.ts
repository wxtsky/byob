import type { NetworkRecord } from '@byob/shared';
import type { CdpSession } from './cdp.js';

export type EndedReason =
  | 'user_stop'
  | 'max_records'
  | 'timeout'
  | 'tab_closed'
  | 'wake_recovery';

export interface RecordingOptions {
  resourceTypes: string[];
  urlPattern: string | undefined;
  includeRequestBody: boolean;
  includeResponseBody: boolean;
  maxBodyBytes: number;
  maxRecords: number;
  captureWebSocketFrames: boolean;
  maxFrameBytes: number;
  timeoutMs: number;
}

export interface RecordingEntry {
  recordingId: string;
  tabId: number;
  session: CdpSession;
  /** Per-requestId accumulators. Insertion order = arrival order. */
  buffer: Map<string, NetworkRecord>;
  /** WebSocket frame total bytes — used to back off after maxRecords*10 budget */
  wsBudgetUsed: number;
  options: RecordingOptions;
  startedAt: number;
  /** Listener cleanup functions installed in network-events.ts. */
  listenerCleanups: Array<() => void>;
  state: 'recording' | 'ended';
  endedReason?: EndedReason;
  endedAt?: number;
  /** setTimeout handle for the user-supplied timeoutMs autoStop. */
  timeoutId: ReturnType<typeof setTimeout> | null;
  /** Chrome onRemoved listener for tab-close detection. */
  tabRemovedListener: ((tabId: number) => void) | null;
  /** True iff this entry currently holds a +1 keepalive ref. */
  keepaliveHeld: boolean;
}

const registry = new Map<string, RecordingEntry>();

const KEEPALIVE_ALARM_NAME = 'byob-record-network-tick';
const ENDED_ENTRY_GC_MULTIPLIER = 2; // ended entry GC'd at 2 * timeoutMs

/** Returns the same Map each call; safe to use from listener factories. */
export function getRegistry(): Map<string, RecordingEntry> {
  return registry;
}

export function addRecording(entry: RecordingEntry): void {
  registry.set(entry.recordingId, entry);
  ensureKeepaliveTick();
}

export function getRecording(id: string): RecordingEntry | undefined {
  return registry.get(id);
}

export function deleteRecording(id: string): void {
  registry.delete(id);
  if (countActive() === 0) clearKeepaliveTick();
}

export function countActive(): number {
  let n = 0;
  for (const e of registry.values()) if (e.state === 'recording') n++;
  return n;
}

/**
 * Install a 25 s no-op chrome.alarms tick. Belt-and-suspenders against MV3 SW
 * eviction during long recordings. Idempotent — installs at most one alarm
 * regardless of how many concurrent recordings exist.
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
 * GC ended entries that have been sitting around too long without being
 * drained by stop_record_network. Prevents leaks from clients that crash
 * after autoStop fires. Run from the keepalive alarm tick.
 */
export function gcEndedEntries(now: number): void {
  for (const [id, e] of registry) {
    if (e.state !== 'ended') continue;
    if (e.endedAt === undefined) continue;
    const ttl = e.options.timeoutMs * ENDED_ENTRY_GC_MULTIPLIER;
    if (now - e.endedAt > ttl) {
      registry.delete(id);
    }
  }
  if (countActive() === 0 && registry.size === 0) clearKeepaliveTick();
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM_NAME) {
    gcEndedEntries(Date.now());
  }
});
