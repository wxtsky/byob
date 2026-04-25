/**
 * Wake-watch — alarm + idle dual detector for system sleep/wake.
 *
 * NOTE: this file is currently a STUB. The full implementation lands in
 * Task 8 of the v0.2 stability plan; Task 4 ships only the public surface
 * (`startWakeWatch`, `registerInFlightForWake`) so background.ts can wire
 * the in-flight map without a circular import.
 *
 * When Task 8 lands it replaces the body of these functions to:
 *   - register a 60s `chrome.alarms` watcher and trigger recovery on a
 *     gap > 90s,
 *   - register `chrome.idle.onStateChanged` and trigger recovery on
 *     idle/locked → active transitions,
 *   - on trigger: abort every controller in the in-flight map and call
 *     `cdp.detachAll()`.
 *
 * Until then these are no-ops so Task 4's signal/cancel work can land
 * independently and stay typecheck-green.
 */

let inFlightGetter: (() => Map<string, AbortController>) | null = null;

/** background.ts injects a getter so we can read its inFlight Map without circular deps. */
export function registerInFlightForWake(getter: () => Map<string, AbortController>): void {
  inFlightGetter = getter;
}

export function startWakeWatch(): void {
  // TODO(task-8): install alarm + idle detectors and wire triggerWakeRecovery.
  // For now we keep the import chain valid but do nothing; the in-flight
  // getter is retained so Task 8 can plug in without touching background.ts.
  void inFlightGetter;
}
