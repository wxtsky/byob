/**
 * The toolbar icon: a badge that says what byob is doing, and the popup's
 * backend (state, pause/resume, answering a handoff).
 *
 * Badge, most important first:
 *   '!'  orange — the agent handed you a tab (browser_wait {user});
 *   'II' grey   — paused;
 *   ' '  green  — a command is running;
 *   none        — idle.
 */
import { inFlightCount, recentActivity, type ActivityEntry } from './activity.js';
import { answerHandoff, focusHandoff, pendingHandoffs, type HandoffAnswer } from './handoff.js';
import { isPaused, setPaused } from './pause.js';

export interface PopupState {
  connected: boolean;
  paused: boolean;
  running: number;
  handoffs: Array<{ id: string; tabId: number; message: string; since: number; title?: string; host?: string }>;
  activity: ActivityEntry[];
}

export type PopupRequest =
  | { target: 'byob-popup'; op: 'state' }
  | { target: 'byob-popup'; op: 'pause'; paused: boolean }
  | { target: 'byob-popup'; op: 'answer'; id: string; answer: HandoffAnswer }
  | { target: 'byob-popup'; op: 'focus'; id: string };

export function badgeFor(s: { paused: boolean; handoffs: number; running: number }): { text: string; color: string; title: string } {
  if (s.handoffs > 0) return { text: '!', color: '#ef6c00', title: 'byob — needs you (open to answer)' };
  if (s.paused) return { text: 'II', color: '#757575', title: 'byob — paused' };
  if (s.running > 0) return { text: ' ', color: '#2e7d32', title: `byob — working (${s.running})` };
  return { text: '', color: '#2e7d32', title: 'byob' };
}

let last = '';

export function refreshBadge(): void {
  if (!chrome.action?.setBadgeText) return;
  const b = badgeFor({ paused: isPaused(), handoffs: pendingHandoffs().length, running: inFlightCount() });
  const key = `${b.text}|${b.color}|${b.title}`;
  if (key === last) return;
  last = key;
  void chrome.action.setBadgeText({ text: b.text }).catch(() => {});
  void chrome.action.setBadgeBackgroundColor({ color: b.color }).catch(() => {});
  chrome.action.setBadgeTextColor?.({ color: '#ffffff' })?.catch?.(() => {});
  void chrome.action.setTitle({ title: b.title }).catch(() => {});
}

async function state(connected: boolean): Promise<PopupState> {
  const handoffs = await Promise.all(
    pendingHandoffs().map(async (h) => {
      const tab = await chrome.tabs.get(h.tabId).catch(() => undefined);
      let host: string | undefined;
      try {
        host = tab?.url ? new URL(tab.url).hostname : undefined;
      } catch {
        host = undefined;
      }
      return { id: h.id, tabId: h.tabId, message: h.message, since: h.since, title: tab?.title, host };
    }),
  );
  return { connected, paused: isPaused(), running: inFlightCount(), handoffs, activity: recentActivity() };
}

/** Only our own popup page may drive these: never a content script or a web page. */
export function isFromPopup(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && !sender.tab && !!sender.url?.startsWith(chrome.runtime.getURL('popup.html'));
}

export function startToolbar(opts: { isConnected: () => boolean }): void {
  refreshBadge();
  chrome.runtime.onMessage.addListener((msg: PopupRequest, sender, reply) => {
    if (!msg || msg.target !== 'byob-popup') return false;
    if (!isFromPopup(sender)) return false;
    void (async () => {
      if (msg.op === 'pause') await setPaused(msg.paused);
      else if (msg.op === 'answer') answerHandoff(msg.id, msg.answer);
      else if (msg.op === 'focus') await focusHandoff(msg.id);
      refreshBadge();
      reply(await state(opts.isConnected()));
    })().catch((e: unknown) => reply({ error: e instanceof Error ? e.message : String(e) }));
    return true;
  });
}
