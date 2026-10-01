import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  _resetDownloadsForTests,
  belongsTo,
  displayName,
  heldForUser,
  listDownloads,
  pickWatch,
  waitDownload,
  watchDownloads,
} from '../downloads.js';

const page = { origin: 'https://shop.test' };

describe('download attribution', () => {
  it('matches by referrer, URL, blob or data origin', () => {
    expect(belongsTo({ url: 'https://cdn.other/f.csv', referrer: 'https://shop.test/orders' }, page)).toBe(true);
    expect(belongsTo({ url: 'https://shop.test/export.csv', referrer: '' }, page)).toBe(true);
    expect(belongsTo({ url: 'blob:https://shop.test/1234', referrer: 'https://shop.test/' }, page)).toBe(true);
    expect(belongsTo({ url: 'data:text/plain,hi', referrer: 'https://shop.test/' }, page)).toBe(true);
  });

  it('accepts a download without referrer on timing alone', () => {
    expect(belongsTo({ url: 'https://s3.cdn/abc?sig=1' }, page)).toBe(true);
  });

  it('refuses one another site started, or another extension', () => {
    expect(belongsTo({ url: 'https://news.test/a.pdf', referrer: 'https://news.test/story' }, page)).toBe(false);
    expect(belongsTo({ url: 'https://shop.test/a.pdf', byExtensionId: 'other' }, page, 'self')).toBe(false);
    expect(belongsTo({ url: 'https://shop.test/a.pdf', byExtensionId: 'self' }, page, 'self')).toBe(true);
  });

  it('picks the most recent watch whose window covers the download', () => {
    const ws = [
      { tabId: 1, origin: 'https://shop.test', since: 100, until: 500 },
      { tabId: 2, origin: 'https://shop.test', since: 200, until: Infinity },
      { tabId: 3, origin: 'https://other.test', since: 300, until: Infinity },
    ];
    const item = { url: 'https://shop.test/x.csv', referrer: 'https://shop.test/' };
    expect(pickWatch(item, ws, 250)?.tabId).toBe(2);
    expect(pickWatch(item, ws, 50)).toBeUndefined();
    expect(pickWatch({ url: 'https://other.test/y', referrer: 'https://other.test/' }, ws, 350)?.tabId).toBe(3);
  });

  it('knows a download Chrome holds for the user from one still scanning', () => {
    expect(heldForUser({ state: 'in_progress', danger: 'uncommon' })).toBe(true);
    expect(heldForUser({ state: 'in_progress', danger: 'asyncScanning' })).toBe(false);
    expect(heldForUser({ state: 'in_progress', danger: 'safe' })).toBe(false);
    expect(heldForUser({ state: 'complete', danger: 'uncommon' })).toBe(false);
  });

  it('names a download by its file, else its URL', () => {
    expect(displayName({ filename: '/tmp/dl/report.csv', url: 'x' })).toBe('report.csv');
    expect(displayName({ filename: '', url: 'https://a.test/files/My%20Report.pdf?x=1' })).toBe('My Report.pdf');
    expect(displayName({ filename: '', url: 'blob:https://a.test/uuid' })).toBe('download');
  });
});

/** A chrome.downloads that the test drives. */
function fakeDownloads() {
  const items = new Map<number, chrome.downloads.DownloadItem>();
  let created: ((i: chrome.downloads.DownloadItem) => void) | undefined;
  let changed: ((d: chrome.downloads.DownloadDelta) => void) | undefined;
  const api = {
    runtime: { id: 'self' },
    downloads: {
      onCreated: { addListener: (f: typeof created) => (created = f) },
      onChanged: { addListener: (f: typeof changed) => (changed = f) },
      search: async ({ id }: { id: number }) => (items.has(id) ? [items.get(id)!] : []),
    },
  };
  const item = (id: number, over: Partial<chrome.downloads.DownloadItem> = {}): chrome.downloads.DownloadItem =>
    ({
      id, url: 'https://shop.test/r.csv', finalUrl: 'https://shop.test/r.csv', referrer: 'https://shop.test/',
      filename: '', state: 'in_progress', danger: 'safe', mime: 'text/csv', bytesReceived: 0, totalBytes: 10,
      startTime: new Date().toISOString(), ...over,
    }) as chrome.downloads.DownloadItem;
  return {
    api,
    create(id: number, over?: Partial<chrome.downloads.DownloadItem>) {
      items.set(id, item(id, over));
      created?.(items.get(id)!);
    },
    finish(id: number, over: Partial<chrome.downloads.DownloadItem> = {}) {
      items.set(id, { ...items.get(id)!, state: 'complete', filename: '/dl/r.csv', bytesReceived: 10, ...over });
      changed?.({ id } as chrome.downloads.DownloadDelta);
    },
  };
}

describe('tracking and waiting', () => {
  const g = globalThis as { chrome?: unknown };
  // downloads.ts registers its listeners on the first watch after a reset.
  const f = fakeDownloads();
  let saved: unknown;
  beforeEach(() => {
    saved = g.chrome;
    g.chrome = f.api;
    _resetDownloadsForTests();
  });
  afterEach(() => {
    g.chrome = saved;
  });

  it('keeps only downloads created while an action is watched', async () => {
    f.create(100); // before any watch: the user's own download
    const w = watchDownloads(7, 'https://shop.test/orders');
    f.create(1);
    const seen = await w.end();
    expect(seen.map((d) => d.id)).toEqual([1]);
    expect(listDownloads().map((d) => d.tabId)).toEqual([7]);
  });

  it('wait returns the finished file and does not return it twice', async () => {
    const w = watchDownloads(7, 'https://shop.test/orders');
    f.create(2);
    await w.end();
    const ac = new AbortController();
    const waiting = waitDownload(undefined, 5000, ac.signal);
    setTimeout(() => f.finish(2), 50);
    const r = await waiting;
    expect(r.download.filename).toBe('/dl/r.csv');
    expect(r.download.state).toBe('complete');
    await expect(waitDownload(undefined, 100, ac.signal)).rejects.toMatchObject({ code: 'download_not_found' });
  });

  it('fails clearly when Chrome holds a dangerous file', async () => {
    const w = watchDownloads(7, 'https://shop.test/orders');
    f.create(3, { danger: 'file' });
    await w.end();
    await expect(waitDownload(3, 1000, new AbortController().signal)).rejects.toMatchObject({ code: 'download_failed' });
  });
});
