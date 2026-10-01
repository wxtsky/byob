/**
 * What the agent has been doing, for the toolbar popup.
 *
 * Deliberately thin: the command name, which tab, that tab's hostname and
 * the outcome. Never parameters — typed text, URLs with their queries,
 * cookie values and page content stay out of it, so the log shows the user
 * *that* something happened without becoming a second copy of their data.
 */

export interface ActivityEntry {
  command: string;
  tabId?: number;
  /** Hostname only. */
  host?: string;
  startedAt: number;
  /** Unset while the command is still running. */
  ms?: number;
  ok?: boolean;
  errorCode?: string;
}

const MAX_ENTRIES = 50;
const entries: ActivityEntry[] = [];
/** Counted apart from the ring: a long-running call may already have scrolled out of it. */
const running = new Set<ActivityEntry>();
let listener: (() => void) | null = null;

/** Called whenever the log or the in-flight count changes (the badge). */
export function onActivityChange(fn: () => void): void {
  listener = fn;
}

export function beginActivity(command: string, tabId?: number): ActivityEntry {
  const e: ActivityEntry = { command, startedAt: Date.now(), ...(tabId !== undefined ? { tabId } : {}) };
  entries.push(e);
  running.add(e);
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  listener?.();
  return e;
}

export function endActivity(
  e: ActivityEntry,
  outcome: { ok: boolean; errorCode?: string; tabId?: number; url?: string },
): void {
  if (!running.delete(e)) return;
  e.ms = Date.now() - e.startedAt;
  e.ok = outcome.ok;
  if (outcome.errorCode) e.errorCode = outcome.errorCode;
  if (outcome.tabId !== undefined) e.tabId = outcome.tabId;
  const host = hostOf(outcome.url);
  if (host) e.host = host;
  listener?.();
}

/** Newest first, copies. */
export function recentActivity(): ActivityEntry[] {
  return entries.map((e) => ({ ...e })).reverse();
}

export function inFlightCount(): number {
  return running.size;
}

export function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return u.hostname || u.protocol.replace(/:$/, '');
  } catch {
    return undefined;
  }
}

/** Test-only. */
export function _resetActivityForTests(): void {
  entries.length = 0;
  running.clear();
  listener = null;
}
