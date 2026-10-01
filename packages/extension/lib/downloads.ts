/**
 * Downloads caused by byob's actions.
 *
 * chrome.downloads items carry no tab id, so a download is attributed to a
 * byob action when it is created while the action runs, or shortly after it
 * (an "Export" click can take the server seconds to answer). Only attributed
 * downloads are ever kept or reported — the user's own download history never
 * reaches the agent.
 */
import { ByobError } from './errors.js';
import { sleepWithSignal } from './signal-utils.js';

export type DownloadState = 'in_progress' | 'interrupted' | 'complete';

export interface TrackedDownload {
  id: number;
  tabId: number;
  url: string;
  /** Absolute path once Chrome has chosen it; '' before. */
  filename: string;
  state: DownloadState;
  mime?: string;
  bytes?: number;
  totalBytes?: number;
  /** Interrupt reason (chrome.downloads.InterruptReason). */
  error?: string;
  danger?: string;
  startedAt: number;
  /** Already handed to the agent by a `wait`. */
  collected?: boolean;
}

/** The part of a chrome.downloads.DownloadItem attribution looks at. */
export interface DownloadOrigin {
  url: string;
  finalUrl?: string;
  referrer?: string;
  byExtensionId?: string;
}

interface Watch {
  tabId: number;
  /** Origin of the page the action ran on. */
  origin: string;
  since: number;
  /** Open-ended while the action runs; set when it ends. */
  until: number;
  onDownload?: (d: TrackedDownload) => void;
}

const MAX_TRACKED = 50;
/** How long after an action a new download still counts as its doing. */
export const LATE_WINDOW_MS = 10_000;

const tracked = new Map<number, TrackedDownload>();
const watches = new Set<Watch>();
const waiters = new Set<() => void>();

export function originOf(url: string | undefined): string {
  if (!url) return '';
  try {
    // blob:https://a.test/uuid → https://a.test; data: → 'null'.
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/**
 * Does this new download belong to the action watched by `w`? Same-origin
 * referrer or URL is a match. A download with no referrer (Referrer-Policy:
 * no-referrer, a redirect to a CDN) is accepted on timing alone. One whose
 * referrer names a different site is someone else's: the user downloading in
 * another tab at the same moment.
 */
export function belongsTo(item: DownloadOrigin, w: Pick<Watch, 'origin'>, selfId?: string): boolean {
  if (item.byExtensionId && item.byExtensionId !== selfId) return false;
  if (!w.origin || w.origin === 'null') return true;
  const urls = [item.url, item.finalUrl, item.referrer];
  if (urls.some((u) => originOf(u) === w.origin)) return true;
  return !item.referrer;
}

/** The watch a download created at `now` belongs to: the most recent matching one. */
export function pickWatch<W extends Watch>(item: DownloadOrigin, ws: Iterable<W>, now: number, selfId?: string): W | undefined {
  let best: W | undefined;
  for (const w of ws) {
    if (now < w.since || now > w.until) continue;
    if (!belongsTo(item, w, selfId)) continue;
    if (!best || w.since > best.since) best = w;
  }
  return best;
}

function selfId(): string | undefined {
  try {
    return chrome.runtime.id;
  } catch {
    return undefined;
  }
}

function fromItem(tabId: number, item: chrome.downloads.DownloadItem): TrackedDownload {
  return {
    id: item.id,
    tabId,
    url: item.finalUrl || item.url,
    filename: item.filename ?? '',
    state: item.state as DownloadState,
    mime: item.mime || undefined,
    bytes: item.bytesReceived,
    totalBytes: item.totalBytes > 0 ? item.totalBytes : undefined,
    error: item.error,
    danger: item.danger,
    startedAt: Date.parse(item.startTime) || Date.now(),
  };
}

function remember(d: TrackedDownload): void {
  tracked.set(d.id, d);
  while (tracked.size > MAX_TRACKED) tracked.delete(tracked.keys().next().value as number);
  for (const fn of waiters) fn();
}

function onCreated(item: chrome.downloads.DownloadItem): void {
  const now = Date.now();
  for (const w of watches) if (now > w.until) watches.delete(w);
  const w = pickWatch(item, watches, now, selfId());
  if (!w) return;
  const d = fromItem(w.tabId, item);
  remember(d);
  w.onDownload?.(d);
}

async function refresh(id: number): Promise<TrackedDownload | undefined> {
  const d = tracked.get(id);
  if (!d) return undefined;
  try {
    const [item] = await chrome.downloads.search({ id });
    if (item) Object.assign(d, fromItem(d.tabId, item), { collected: d.collected, startedAt: d.startedAt });
  } catch {
    // search failed (download removed from history); keep what we have
  }
  return d;
}

function onChanged(delta: chrome.downloads.DownloadDelta): void {
  if (!tracked.has(delta.id)) return;
  void refresh(delta.id).then(() => {
    for (const fn of waiters) fn();
  });
}

let started = false;
/** Register the chrome.downloads listeners once. */
export function startDownloadTracking(): void {
  if (started) return;
  started = true;
  try {
    chrome.downloads.onCreated.addListener(onCreated);
    chrome.downloads.onChanged.addListener(onChanged);
  } catch (e) {
    console.warn('[byob/downloads] chrome.downloads unavailable:', e);
  }
}

/**
 * Attribute downloads created from now on to an action on `tabId`. `end()`
 * returns those seen so far and keeps attributing late ones to the tab for
 * LATE_WINDOW_MS, without calling `onDownload` any more.
 */
export function watchDownloads(
  tabId: number,
  pageUrl: string,
  onDownload?: (d: TrackedDownload) => void,
): { seen: () => TrackedDownload[]; end: () => Promise<TrackedDownload[]> } {
  startDownloadTracking();
  const seen: TrackedDownload[] = [];
  const w: Watch = {
    tabId,
    origin: originOf(pageUrl),
    since: Date.now(),
    until: Number.POSITIVE_INFINITY,
    onDownload: (d) => {
      seen.push(d);
      onDownload?.(d);
    },
  };
  watches.add(w);
  let ended: Promise<TrackedDownload[]> | null = null;
  return {
    seen: () => seen,
    end: () => {
      if (!ended) {
        w.until = Date.now() + LATE_WINDOW_MS;
        w.onDownload = undefined;
        ended = Promise.all(seen.map((d) => refresh(d.id).then((r) => ({ ...(r ?? d) }))));
      }
      return ended;
    },
  };
}

export function listDownloads(): TrackedDownload[] {
  return [...tracked.values()].reverse();
}

/** Dangers Chrome is still deciding on (scanning): keep waiting. */
const SCANNING = new Set(['asyncScanning', 'asyncLocalPasswordScanning']);
/** Dangers that let a download complete on its own. */
const SAFE = new Set(['safe', 'accepted', 'allowlistedByPolicy', 'deepScannedSafe', 'deepScannedOpenedDangerous']);

/** In progress, but held by Chrome until the user keeps or discards it. */
export function heldForUser(d: Pick<TrackedDownload, 'state' | 'danger'>): boolean {
  return d.state === 'in_progress' && !!d.danger && !SAFE.has(d.danger) && !SCANNING.has(d.danger);
}

function basename(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

/** File name to show: the chosen file's, else the URL's last segment. */
export function displayName(d: Pick<TrackedDownload, 'filename' | 'url'>): string {
  if (d.filename) return basename(d.filename);
  if (/^https?:/i.test(d.url)) {
    const last = d.url.split(/[?#]/)[0]!.split('/').pop();
    if (last) {
      try {
        return decodeURIComponent(last);
      } catch {
        return last;
      }
    }
  }
  return 'download';
}

/**
 * Wait for a download to finish. Without `id`: the newest download byob's
 * actions started that no earlier wait returned — and if there is none yet,
 * the next one (an "Export" click may still be waiting for the server).
 * Returns `{ download, inProgress: true }` when the time runs out first.
 */
export async function waitDownload(
  id: number | undefined,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<{ download: TrackedDownload; inProgress?: true }> {
  const deadline = Date.now() + timeoutMs;
  let wake: (() => void) | null = null;
  const poke = (): void => wake?.();
  waiters.add(poke);
  try {
    const nap = async (ms: number): Promise<void> => {
      await Promise.race([
        sleepWithSignal(Math.max(0, Math.min(ms, deadline - Date.now())), signal),
        new Promise<void>((r) => (wake = r)),
      ]);
      wake = null;
    };

    let d: TrackedDownload | undefined;
    if (id !== undefined) {
      d = tracked.get(id);
      if (!d) {
        throw new ByobError('download_not_found', `No download ${id} among the ones byob's actions started.`,
          'browser_downloads list shows them; downloads the user started are never reported.');
      }
    } else {
      for (;;) {
        d = listDownloads().find((x) => !x.collected);
        if (d || Date.now() >= deadline) break;
        await nap(500);
      }
      if (!d) {
        throw new ByobError('download_not_found', `No download started by byob's actions within ${Math.round(timeoutMs / 1000)}s.`,
          'Click the download link or button first; the click result says "download started" when it worked.');
      }
    }

    for (;;) {
      d = (await refresh(d.id)) ?? d;
      if (d.state === 'complete') {
        d.collected = true;
        return { download: { ...d } };
      }
      if (d.state === 'interrupted') {
        d.collected = true;
        throw new ByobError('download_failed', `Download of ${displayName(d)} failed: ${d.error ?? 'interrupted'}.`);
      }
      if (heldForUser(d)) {
        throw new ByobError('download_failed',
          `Chrome is holding ${displayName(d)} as potentially harmful (${d.danger}).`,
          'Only the user can keep or discard it (Chrome\'s downloads bubble or chrome://downloads). Tell them.');
      }
      if (Date.now() >= deadline) return { download: { ...d }, inProgress: true };
      await nap(1000);
    }
  } finally {
    waiters.delete(poke);
  }
}

/** Test-only. */
export function _resetDownloadsForTests(): void {
  started = false;
  tracked.clear();
  watches.clear();
  waiters.clear();
}
