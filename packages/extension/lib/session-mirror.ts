/**
 * Domains mirrored onto a tab's out-of-process iframe sessions.
 *
 * Each OOPIF (a cross-site iframe: payment widgets, sign-in buttons,
 * embeds) is its own flatten-attached CDP session, and Network / Fetch
 * enabled on the tab session never see its requests. A network recording or
 * an intercept registers its enable command here under an owner key: it is
 * sent to every child session the tab has now and, through the event hub, to
 * each one attached later. A domain is disabled on the children once its
 * last owner leaves.
 *
 * While anything is mirrored, new children start paused
 * (waitForDebuggerOnStart) so an iframe's first requests aren't missed; the
 * event hub queues the enables and then resumes them.
 */
import { oopifSessions } from './dom/frames.js';

export type MirroredDomain = 'Network' | 'Fetch';

interface Mirror {
  domain: MirroredDomain;
  params: Record<string, unknown>;
}

/** tabId → owner → what it enabled. */
const byTab = new Map<number, Map<string, Mirror>>();

function sendTo(tabId: number, sessionId: string | undefined, method: string, params: Record<string, unknown> = {}): void {
  const target = (sessionId ? { tabId, sessionId } : { tabId }) as chrome.debugger.Debuggee;
  chrome.debugger.sendCommand(target, method, params, () => {
    void chrome.runtime.lastError; // a child may detach mid-flight
  });
}

function setPauseOnStart(tabId: number, paused: boolean): void {
  const params = { autoAttach: true, waitForDebuggerOnStart: paused, flatten: true };
  sendTo(tabId, undefined, 'Target.setAutoAttach', params);
  for (const sid of oopifSessions(tabId)) sendTo(tabId, sid, 'Target.setAutoAttach', params);
}

/** Enable `domain` on every OOPIF of the tab, now and later, on behalf of `owner`. */
export function addMirror(tabId: number, owner: string, domain: MirroredDomain, params: Record<string, unknown> = {}): void {
  let m = byTab.get(tabId);
  const wasMirroring = !!m?.size;
  if (!m) {
    m = new Map();
    byTab.set(tabId, m);
  }
  m.set(owner, { domain, params });
  for (const sid of oopifSessions(tabId)) sendTo(tabId, sid, `${domain}.enable`, params);
  if (!wasMirroring) setPauseOnStart(tabId, true);
}

/** `owner` is done; disable its domain on the children if nobody else needs it. */
export function removeMirror(tabId: number, owner: string): void {
  const m = byTab.get(tabId);
  const gone = m?.get(owner);
  if (!m || !gone) return;
  m.delete(owner);
  if (![...m.values()].some((v) => v.domain === gone.domain)) {
    for (const sid of oopifSessions(tabId)) sendTo(tabId, sid, `${gone.domain}.disable`);
  }
  if (m.size === 0) {
    byTab.delete(tabId);
    setPauseOnStart(tabId, false);
  }
}

/** The enables a freshly attached child needs, one per domain (latest params win). */
export function mirrorCommands(tabId: number): Array<[string, Record<string, unknown>]> {
  const latest = new Map<MirroredDomain, Record<string, unknown>>();
  for (const v of byTab.get(tabId)?.values() ?? []) latest.set(v.domain, v.params);
  return [...latest].map(([domain, params]) => [`${domain}.enable`, params]);
}

export function isMirroring(tabId: number): boolean {
  return (byTab.get(tabId)?.size ?? 0) > 0;
}

/** The tab's attachment is gone: its children went with it. */
export function forgetTabMirrors(tabId: number): void {
  byTab.delete(tabId);
}
