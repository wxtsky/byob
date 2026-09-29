/**
 * Observe what an action caused.
 *
 * After a click / key press / submit, the agent's next question is always
 * "what happened?". Instead of making it poll, the action is wrapped: we
 * listen for navigations, new tabs and JS dialogs while it runs, give the
 * page a short grace period to react, wait for any navigation it started to
 * finish loading, and report the effects alongside the result.
 */
import { observe, type HubEvent } from './event-hub.js';
import { getDialog } from './dialog-registry.js';
import { mainFrameInfo } from './dom/frames.js';
import type { CdpSession } from './cdp.js';

export interface ActionEffects {
  /** Main-frame navigation (or same-document URL change) caused by the action. */
  navigated?: { url: string; title: string; sameDocument: boolean };
  /** Load did not finish within the budget (page still loading). */
  stillLoading?: boolean;
  newTabs?: Array<{ tabId: number; url: string }>;
  dialog?: { type: string; message: string };
}

export interface SettleOptions {
  /** How long to wait for the page to *start* reacting. */
  graceMs?: number;
  /** Upper bound for a started navigation to reach the load event. */
  loadTimeoutMs?: number;
  signal?: AbortSignal;
}

export async function withEffects<T>(
  session: CdpSession,
  action: () => Promise<T>,
  opts: SettleOptions = {},
): Promise<{ result: T | undefined; effects: ActionEffects; interrupted: boolean }> {
  const tabId = session.tabId;
  // Navigation requests are reported while the input event is still being
  // handled, so a short grace catches them without taxing every click.
  const graceMs = opts.graceMs ?? 80;
  const loadTimeoutMs = opts.loadTimeoutMs ?? 15_000;

  let mainFrameId: string | undefined;
  let beforeUrl = '';
  try {
    const m = await mainFrameInfo(session, opts.signal);
    mainFrameId = m.frameId;
    beforeUrl = m.url;
  } catch {
    /* best effort */
  }

  let navRequested = false;
  let expectNewTab = false;
  let navStarted = false;
  let loaded = false;
  let sameDocUrl: string | undefined;
  let wake: (() => void) | null = null;
  const poke = (): void => wake?.();
  // A JS dialog blocks the page: the input command that triggered it won't
  // return until someone answers the dialog. Race the action against it.
  let dialogOpened!: () => void;
  const dialogPromise = new Promise<'dialog'>((r) => (dialogOpened = () => r('dialog')));

  const unobserve = observe((e: HubEvent) => {
    if (e.tabId !== tabId) return;
    if (e.method === 'Page.javascriptDialogOpening') {
      dialogOpened();
      poke();
      return;
    }
    if (e.sessionId) return;
    const fid = e.params?.frameId ?? e.params?.frame?.id;
    switch (e.method) {
      // A requested navigation is only a hint (it may be cancelled or turn
      // into a download); it buys a short wait for the load to start.
      case 'Page.windowOpen':
        expectNewTab = true;
        poke();
        break;
      case 'Page.frameRequestedNavigation':
      case 'Page.frameScheduledNavigation':
        if (e.params?.disposition && e.params.disposition !== 'currentTab') {
          expectNewTab = true;
          poke();
          break;
        }
        if (!mainFrameId || fid === mainFrameId) {
          navRequested = true;
          poke();
        }
        break;
      case 'Page.frameStartedLoading':
        if (!mainFrameId || fid === mainFrameId) {
          navStarted = true;
          loaded = false;
          poke();
        }
        break;
      case 'Page.navigatedWithinDocument':
        if (!mainFrameId || fid === mainFrameId) {
          sameDocUrl = e.params.url;
          poke();
        }
        break;
      case 'Page.loadEventFired':
        loaded = true;
        poke();
        break;
      case 'Page.frameStoppedLoading':
        if (!mainFrameId || fid === mainFrameId) {
          loaded = true;
          poke();
        }
        break;
      case 'Page.javascriptDialogOpening':
        dialogOpened();
        poke();
        break;
    }
  });

  const newTabs: Array<{ tabId: number; url: string }> = [];
  let ownWindow: number | undefined;
  try {
    ownWindow = (await chrome.tabs.get(tabId)).windowId;
  } catch { /* tab gone */ }
  const onCreated = (t: chrome.tabs.Tab): void => {
    if (t.id === undefined) return;
    // target=_blank implies noopener, which leaves openerTabId unset; while
    // the page is known to be opening a window, a tab appearing in the same
    // window is that window.
    if (t.openerTabId === tabId || (expectNewTab && t.windowId === ownWindow)) {
      newTabs.push({ tabId: t.id, url: t.pendingUrl ?? t.url ?? '' });
      poke();
    } else {
      pendingCreated.push(t);
    }
  };
  const pendingCreated: chrome.tabs.Tab[] = [];
  chrome.tabs.onCreated.addListener(onCreated);

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const t = setTimeout(() => {
        wake = null;
        resolve();
      }, ms);
      wake = () => {
        clearTimeout(t);
        wake = null;
        resolve();
      };
    });

  try {
    const running = action();
    // If the dialog wins, the action's promise settles only after the dialog
    // is answered; keep its eventual rejection from going unhandled.
    running.catch(() => {});
    const raced = await Promise.race([running, dialogPromise]);
    // A dialog won: the action is suspended inside the page until the
    // dialog is answered, so it has no result yet.
    const interrupted = raced === 'dialog';
    const result = interrupted ? undefined : (raced as T);
    const graceEnd = Date.now() + graceMs;
    while (Date.now() < graceEnd && !navStarted && !navRequested && !expectNewTab && !getDialog(tabId)) {
      await sleep(graceEnd - Date.now());
    }
    if (expectNewTab && !newTabs.length) {
      // The tab may have been created before windowOpen was observed.
      for (const t of pendingCreated) if (t.windowId === ownWindow && t.id !== undefined) newTabs.push({ tabId: t.id, url: t.pendingUrl ?? t.url ?? '' });
      const end = Date.now() + 1500;
      while (!newTabs.length && Date.now() < end) await sleep(end - Date.now());
    }
    if (navRequested && !navStarted) {
      const startEnd = Date.now() + 1500;
      while (!navStarted && !getDialog(tabId) && Date.now() < startEnd) await sleep(startEnd - Date.now());
    }
    const loadEnd = Date.now() + loadTimeoutMs;
    while (navStarted && !loaded && !getDialog(tabId) && Date.now() < loadEnd) {
      if (opts.signal?.aborted) break;
      await sleep(Math.min(250, loadEnd - Date.now()));
    }

    const effects: ActionEffects = {};
    const dialog = getDialog(tabId);
    if (dialog) effects.dialog = { type: dialog.type, message: dialog.message.slice(0, 300) };
    if (newTabs.length) {
      // pendingUrl is often empty at creation time; refresh once.
      for (const nt of newTabs) {
        try {
          const t = await chrome.tabs.get(nt.tabId);
          nt.url = t.url || t.pendingUrl || nt.url;
        } catch { /* closed already */ }
      }
      effects.newTabs = newTabs;
    }
    if (navStarted || sameDocUrl) {
      try {
        const t = await chrome.tabs.get(tabId);
        const url = t.url ?? sameDocUrl ?? '';
        if (url !== beforeUrl || navStarted) {
          effects.navigated = { url, title: t.title ?? '', sameDocument: !navStarted };
        }
      } catch { /* tab closed by the action */ }
      if (navStarted && !loaded && !effects.dialog) effects.stillLoading = true;
    }
    return { result, effects, interrupted };
  } finally {
    unobserve();
    chrome.tabs.onCreated.removeListener(onCreated);
  }
}
