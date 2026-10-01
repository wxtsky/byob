/**
 * Handing a tab to the user: `browser_wait {user: "Log in, then click Done"}`.
 *
 * For what the agent must not or cannot do itself — logins, CAPTCHAs, 2FA,
 * confirming a payment. byob brings the tab to the front, shows a
 * notification and the toolbar badge, and waits until the user answers in
 * the toolbar popup or the notification. Both are extension UI the page can
 * neither see nor click, so a page can't answer on the user's behalf; and
 * nothing is injected into the page, so this also works on sign-in pages
 * byob's site policy keeps it out of.
 *
 * An answer outlives the agent's wait: if the call times out (`pending`) and
 * the user clicks Done later, the next `wait {user}` on that tab returns it
 * at once.
 */

export type HandoffAnswer = 'done' | 'declined';
export type HandoffOutcome = HandoffAnswer | 'pending' | 'tab_closed';

export interface Handoff {
  id: string;
  tabId: number;
  message: string;
  since: number;
  answer?: HandoffAnswer;
}

const byTab = new Map<number, Handoff>();
const waiters = new Map<number, Set<(o: HandoffOutcome) => void>>();
let changed: (() => void) | null = null;

const NOTIFICATION_PREFIX = 'byob-handoff:';
const ICON = 'icon/128.png';

/** Badge / popup refresh hook. */
export function onHandoffChange(fn: () => void): void {
  changed = fn;
}

/** Handoffs the user hasn't answered yet. */
export function pendingHandoffs(): Handoff[] {
  return [...byTab.values()].filter((h) => !h.answer).map((h) => ({ ...h }));
}

function settle(tabId: number, outcome: HandoffOutcome): boolean {
  const ws = waiters.get(tabId);
  if (!ws?.size) return false;
  waiters.delete(tabId);
  for (const w of ws) w(outcome);
  return true;
}

/** The user answered (popup or notification). False when the id is unknown. */
export function answerHandoff(id: string, answer: HandoffAnswer): boolean {
  const h = [...byTab.values()].find((x) => x.id === id);
  if (!h || h.answer) return false;
  clearNotification(h.id);
  if (settle(h.tabId, answer)) byTab.delete(h.tabId);
  else h.answer = answer; // nobody waiting right now: keep it for the next wait
  changed?.();
  return true;
}

function forgetTab(tabId: number): void {
  const h = byTab.get(tabId);
  if (!h) return;
  byTab.delete(tabId);
  clearNotification(h.id);
  settle(tabId, 'tab_closed');
  changed?.();
}

/**
 * Hand `tabId` to the user and wait up to `timeoutMs` for their answer.
 * Abort (cancel / pause) rejects; the handoff stays open for a later wait.
 */
export async function waitForUser(
  tabId: number,
  message: string,
  timeoutMs: number,
  signal: AbortSignal,
  ui: { focus?: boolean } = {},
): Promise<HandoffOutcome> {
  let h = byTab.get(tabId);
  if (h?.answer) {
    byTab.delete(tabId);
    changed?.();
    return h.answer;
  }
  if (!h) {
    h = { id: crypto.randomUUID(), tabId, message, since: Date.now() };
    byTab.set(tabId, h);
    changed?.();
    if (ui.focus !== false) await bringToFront(tabId);
    notify(h);
  } else if (h.message !== message) {
    // Same open request, updated wording.
    h.message = message;
    notify(h);
    changed?.();
  }
  if (signal.aborted) throw new DOMException('aborted', 'AbortError');
  return new Promise<HandoffOutcome>((resolve, reject) => {
    let set = waiters.get(tabId);
    if (!set) waiters.set(tabId, (set = new Set()));
    const done = (o: HandoffOutcome): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      set!.delete(done);
      resolve(o);
    };
    const onAbort = (): void => {
      clearTimeout(timer);
      set!.delete(done);
      reject(new DOMException('aborted', 'AbortError'));
    };
    const timer = setTimeout(() => done('pending'), timeoutMs);
    signal.addEventListener('abort', onAbort, { once: true });
    set.add(done);
  });
}

async function bringToFront(tabId: number): Promise<void> {
  try {
    const tab = await chrome.tabs.update(tabId, { active: true });
    if (tab?.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true, drawAttention: true });
  } catch (e) {
    console.warn('[byob/handoff] could not bring the tab to the front', e);
  }
}

function notify(h: Handoff): void {
  if (!chrome.notifications?.create) return;
  chrome.notifications.create(
    NOTIFICATION_PREFIX + h.id,
    {
      type: 'basic',
      iconUrl: chrome.runtime.getURL(ICON),
      title: 'byob needs you',
      message: h.message.slice(0, 300),
      contextMessage: 'Answer here or in the byob toolbar popup.',
      buttons: [{ title: 'Done' }, { title: "I can't" }],
      requireInteraction: true,
      priority: 2,
    },
    () => void chrome.runtime.lastError,
  );
}

function clearNotification(id: string): void {
  chrome.notifications?.clear?.(NOTIFICATION_PREFIX + id, () => void chrome.runtime.lastError);
}

function idOfNotification(notificationId: string): string | null {
  return notificationId.startsWith(NOTIFICATION_PREFIX) ? notificationId.slice(NOTIFICATION_PREFIX.length) : null;
}

/** Bring a handoff's tab to the front (popup row / notification body click). */
export async function focusHandoff(id: string): Promise<void> {
  const h = [...byTab.values()].find((x) => x.id === id);
  if (h) await bringToFront(h.tabId);
}

let started = false;

export function startHandoff(): void {
  if (started) return;
  started = true;
  chrome.tabs.onRemoved.addListener(forgetTab);
  if (chrome.notifications?.onButtonClicked) {
    chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
      const id = idOfNotification(notificationId);
      if (id) answerHandoff(id, buttonIndex === 0 ? 'done' : 'declined');
    });
    chrome.notifications.onClicked.addListener((notificationId) => {
      const id = idOfNotification(notificationId);
      if (id) void focusHandoff(id);
    });
  }
}

/** Test-only. */
export function _resetHandoffsForTests(): void {
  byTab.clear();
  waiters.clear();
  changed = null;
}
