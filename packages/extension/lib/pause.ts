/**
 * The user's kill switch (toolbar popup → Pause).
 *
 * While paused every browser command is refused, and pausing aborts what is
 * already running. Only the popup can flip it: no MCP tool or bridge route
 * reaches chrome.storage.local, so an agent can't resume itself.
 */
import { ByobError } from './errors.js';

export const PAUSED_KEY = 'BYOB_PAUSED';

/** Commands that keep working while paused: the user's own CLI. */
const ALWAYS_ALLOWED = new Set(['policy']);

let paused = false;
let onChange: ((paused: boolean, was: boolean) => void) | null = null;

export function isPaused(): boolean {
  return paused;
}

/** The refusal for `command` while paused, or null when it may run. */
export function pauseGate(command: string, isPausedNow = paused): ByobError | null {
  if (!isPausedNow || ALWAYS_ALLOWED.has(command)) return null;
  return pausedError();
}

export function pausedError(): ByobError {
  return new ByobError('paused', 'The user paused byob from the toolbar.',
    'Ask the user to resume it (byob toolbar icon → Resume).');
}

/** Popup only. */
export async function setPaused(value: boolean): Promise<void> {
  await chrome.storage.local.set({ [PAUSED_KEY]: value });
  apply(value);
}

function apply(value: boolean): void {
  const was = paused;
  paused = value;
  if (value !== was) onChange?.(value, was);
}

/**
 * Load the persisted switch and follow later changes. `changed` runs on every
 * flip (pausing aborts in-flight work; both refresh the badge).
 */
export async function startPause(changed: (paused: boolean, was: boolean) => void): Promise<void> {
  onChange = changed;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[PAUSED_KEY]) apply(changes[PAUSED_KEY].newValue === true);
  });
  const stored = await chrome.storage.local.get(PAUSED_KEY);
  apply(stored[PAUSED_KEY] === true);
}

/** Test-only. */
export function _setPausedForTests(value: boolean): void {
  paused = value;
}
