import { detachAll } from './cdp.js';
import { getRegistry } from './recording-registry.js';
import { endRecording } from './handlers/start-record-network.js';

/**
 * Two redundant detectors for system wake (mac sleep/wake, lid close-open):
 *   1. chrome.alarms gap: we set a 60s periodic alarm; if a tick arrives more
 *      than 90s after the previous one, the system was asleep — fire recovery.
 *   2. chrome.idle.onStateChanged: when state transitions idle/locked → active
 *      we conservatively assume a wake just occurred — fire recovery.
 *
 * Repeated triggers are idempotent: detachAll is harmless if no sessions are
 * attached, and aborting an already-aborted controller is a no-op.
 *
 * Recovery on wake:
 *   • abort every in-flight handler (so any stuck CDP awaits return promptly)
 *   • detach every CDP session (state across sleep is unreliable)
 *   • do NOT reattach proactively — next handler call will attach fresh
 */

const ALARM_NAME = 'byob-wake-watch';
const ALARM_PERIOD_MIN = 1; // 60s
const WAKE_GAP_MS = 90 * 1000;
const IDLE_DETECTION_INTERVAL_S = 60;

let lastTickAt = Date.now();
let lastIdleState: chrome.idle.IdleState = 'active';
let started = false;

/** background.ts injects a getter so we can read its inFlight Map without circular deps. */
let inFlightGetter: (() => Map<string, AbortController>) | null = null;

export function registerInFlightForWake(getter: () => Map<string, AbortController>): void {
  inFlightGetter = getter;
}

function abortAllInFlight(reason: string): void {
  const m = inFlightGetter?.();
  if (!m) return;
  for (const [, ctrl] of m) {
    try {
      ctrl.abort(reason);
    } catch {
      // ignore
    }
  }
  m.clear();
}

async function triggerWakeRecovery(source: 'alarm' | 'idle'): Promise<void> {
  console.warn(`[byob/wake-watch] triggered by ${source}, aborting in-flight + detachAll`);
  abortAllInFlight('aborted_due_to_wake');
  // End any active recording with the dedicated reason so the entry's
  // endedReason is no longer the dead 'timeout' fallback. We run all
  // shutdowns in parallel and swallow per-entry failures so a single
  // broken recording can't crash the wake handler.
  const endings: Array<Promise<void>> = [];
  for (const e of getRegistry().values()) {
    if (e.state !== 'recording') continue;
    endings.push(
      endRecording(e.recordingId, 'wake_recovery').catch((err) => {
        console.warn(
          `[byob/wake-watch] endRecording(${e.recordingId}) failed (ignored):`,
          err,
        );
      }),
    );
  }
  if (endings.length > 0) await Promise.all(endings);
  try {
    await detachAll();
  } catch (e) {
    console.warn('[byob/wake-watch] detachAll error (ignored):', e);
  }
}

export function startWakeWatch(): void {
  if (started) return;
  started = true;

  // Detector 1: alarm gap
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_PERIOD_MIN });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== ALARM_NAME) return;
    const now = Date.now();
    const elapsed = now - lastTickAt;
    lastTickAt = now;
    if (elapsed > WAKE_GAP_MS) {
      void triggerWakeRecovery('alarm');
    }
  });

  // Detector 2: idle state
  try {
    chrome.idle.setDetectionInterval(IDLE_DETECTION_INTERVAL_S);
  } catch (e) {
    console.warn('[byob/wake-watch] chrome.idle not available:', e);
  }
  chrome.idle.onStateChanged.addListener((state) => {
    if ((lastIdleState === 'idle' || lastIdleState === 'locked') && state === 'active') {
      void triggerWakeRecovery('idle');
    }
    lastIdleState = state;
  });
}

// --- Internals exposed for unit tests ---
export const __test = {
  evaluateAlarmGap(prevTickAt: number, nowMs: number): boolean {
    return nowMs - prevTickAt > WAKE_GAP_MS;
  },
  evaluateIdleTransition(
    previous: chrome.idle.IdleState,
    next: chrome.idle.IdleState,
  ): boolean {
    return (previous === 'idle' || previous === 'locked') && next === 'active';
  },
};
