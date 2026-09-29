/** browser_tabs and browser_navigate. */
import { Tools } from '@byob/shared';
import { ByobError } from '../errors.js';
import { checkHostPolicy, checkUrlAllowed, urlForbiddenError } from '../url-guard.js';
import { checkTabAccess } from '../tab-access.js';
import { actionAndWaitLoad, navigateAndWait, openAgentTab, waitFirstLoad } from '../tab.js';
import { waitForNetworkIdle } from '../network-idle.js';
import { throwIfAborted } from '../signal-utils.js';
import { attach, pickTab, tabSummary } from './_common.js';
import { snapshotAfter } from './snapshot.js';

function assertUrl(url: string): void {
  const g = checkUrlAllowed(url);
  if (!g.ok) {
    const env = urlForbiddenError(g.reason);
    throw new ByobError('url_forbidden', env.message, env.hint);
  }
}

async function accessibleTab(tabId: number): Promise<chrome.tabs.Tab> {
  const access = await checkTabAccess(tabId, { allowForbiddenProtocol: true });
  if (!access.ok) {
    const env = access.error as { error: string; message: string; hint?: string };
    throw new ByobError(env.error as never, env.message, env.hint);
  }
  return access.tab;
}

async function waitStrategy(
  tabId: number,
  waitUntil: 'load' | 'networkidle' | 'none',
  timeoutMs: number,
  signal: AbortSignal,
): Promise<boolean> {
  if (waitUntil === 'networkidle') {
    await waitForNetworkIdle(tabId, Math.max(1000, timeoutMs), signal);
  }
  return true;
}

export async function handleNavigate(raw: unknown, signal: AbortSignal): Promise<unknown> {
  const p = Tools.NavigateInput.parse(raw);
  const timeoutMs = p.timeoutSec * 1000;
  let tabId: number;
  let opened = false;
  let timedOut = false;

  if (p.action === 'goto') {
    if (!p.url) throw new ByobError('invalid_argument', 'browser_navigate: url is required.');
    const url = /^[a-z][a-z0-9+.-]*:/i.test(p.url) ? p.url : `https://${p.url}`;
    assertUrl(url);
    throwIfAborted(signal);
    if (p.newTab || p.tabId === undefined) {
      tabId = await openAgentTab(url);
      opened = true;
      if (p.waitUntil !== 'none') {
        try {
          await waitFirstLoad(tabId, timeoutMs, signal);
        } catch (e) {
          if ((e as { name?: string }).name === 'AbortError') throw e;
          timedOut = true;
        }
      }
    } else {
      tabId = p.tabId;
      await accessibleTab(tabId);
      if (p.waitUntil === 'none') {
        await chrome.tabs.update(tabId, { url });
      } else {
        try {
          await navigateAndWait(tabId, url, timeoutMs, signal);
        } catch (e) {
          if ((e as { name?: string }).name === 'AbortError') throw e;
          timedOut = true;
        }
      }
    }
  } else {
    tabId = await pickTab(p);
    await accessibleTab(tabId);
    const start =
      p.action === 'reload' ? () => chrome.tabs.reload(tabId)
      : p.action === 'back' ? () => chrome.tabs.goBack(tabId)
      : () => chrome.tabs.goForward(tabId);
    try {
      await actionAndWaitLoad(tabId, start, timeoutMs, signal);
    } catch (e) {
      if ((e as { name?: string }).name === 'AbortError') throw e;
      const msg = e instanceof Error ? e.message : String(e);
      if (/history|cannot find/i.test(msg)) {
        throw new ByobError('no_history', `Cannot go ${p.action}: no ${p.action === 'back' ? 'previous' : 'next'} page in this tab.`);
      }
      timedOut = true;
    }
  }

  if (!timedOut && p.waitUntil === 'networkidle') await waitStrategy(tabId, 'networkidle', timeoutMs, signal);
  const info = await tabSummary(tabId);
  const snap = p.snapshot ? await snapshotAfter(await attach(tabId, signal), true, signal) : {};
  return { ...info, opened, ...(timedOut ? { stillLoading: true } : {}), ...snap };
}

export async function handleTabs(raw: unknown, signal: AbortSignal): Promise<unknown> {
  const p = Tools.TabsInput.parse(raw);
  throwIfAborted(signal);
  switch (p.action) {
    case 'list': {
      const all = (await chrome.tabs.query({})).filter((t) => t.id !== undefined);
      const groups = chrome.tabGroups ? await chrome.tabGroups.query({ title: 'byob' }).catch(() => []) : [];
      const byobGroups = new Set(groups.map((g) => g.id));
      const visible = all.filter((t) => checkHostPolicy(t.url).ok);
      return {
        tabs: visible.map((t) => ({
          tabId: t.id!,
          title: t.title ?? '',
          url: t.url ?? '',
          active: !!t.active,
          windowId: t.windowId,
          agent: t.groupId !== undefined && byobGroups.has(t.groupId),
        })),
        hiddenByPolicy: all.length - visible.length,
      };
    }
    case 'new': {
      const url = p.url ?? 'about:blank';
      if (p.url) assertUrl(url);
      const tabId = await openAgentTab(url, { active: !!p.focus });
      if (p.url) await waitFirstLoad(tabId, 30_000, signal).catch(() => {});
      return { ...(await tabSummary(tabId)), opened: true };
    }
    case 'select': {
      if (p.tabId === undefined) throw new ByobError('invalid_argument', 'browser_tabs select: tabId is required.');
      const t = await accessibleTab(p.tabId);
      if (p.focus) {
        if (t.windowId !== undefined) await chrome.windows.update(t.windowId, { focused: true });
        await chrome.tabs.update(p.tabId, { active: true });
      }
      return await tabSummary(p.tabId);
    }
    case 'close': {
      if (p.tabId === undefined) throw new ByobError('invalid_argument', 'browser_tabs close: tabId is required.');
      await accessibleTab(p.tabId);
      const info = await tabSummary(p.tabId);
      await chrome.tabs.remove(p.tabId);
      return { ...info, closed: true };
    }
    case 'history': {
      const results = await chrome.history.search({ text: p.query ?? '', maxResults: p.limit ?? 30, startTime: 0 });
      const entries: Array<{ url: string; title: string; lastVisit: string }> = [];
      let hidden = 0;
      for (const it of results) {
        if (!it.url) continue;
        if (!checkUrlAllowed(it.url).ok) {
          hidden++;
          continue;
        }
        entries.push({ url: it.url, title: it.title ?? '', lastVisit: new Date(it.lastVisitTime ?? 0).toISOString() });
      }
      return { history: entries, hiddenByPolicy: hidden };
    }
  }
}
