import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { detachAll, tryAttachToTab } from '../cdp.js';

/** A chrome.debugger that records calls and fails on demand. */
function fakeChrome(opts: { failOnce?: Record<string, string>; attachError?: string } = {}) {
  const calls: string[] = [];
  const failOnce = { ...opts.failOnce };
  let attachError = opts.attachError;
  let attached = false;
  const chrome = {
    runtime: { lastError: undefined as { message: string } | undefined },
    tabs: {
      get: async (tabId: number) => ({ id: tabId, url: 'https://a.test/', discarded: false }),
      onRemoved: { addListener() {}, hasListener: () => true },
    },
    debugger: {
      attach: async () => {
        calls.push('attach');
        await new Promise((r) => setTimeout(r, 5));
        if (attachError) {
          const m = attachError;
          attachError = undefined;
          throw new Error(m);
        }
        if (attached) throw new Error('Another debugger is already attached to the tab with id: 1.');
        attached = true;
      },
      detach: async () => {
        calls.push('detach');
        attached = false;
      },
      sendCommand: (_t: unknown, method: string, _p: unknown, cb: (r?: unknown) => void) => {
        calls.push(method);
        const err = failOnce[method];
        if (err) delete failOnce[method];
        chrome.runtime.lastError = err ? { message: err } : undefined;
        cb({});
        chrome.runtime.lastError = undefined;
      },
      onDetach: { addListener() {}, hasListener: () => true },
    },
  };
  return { chrome, calls, isAttached: () => attached };
}

const g = globalThis as { chrome?: unknown };
let saved: unknown;
beforeEach(() => {
  saved = g.chrome;
});
afterEach(async () => {
  await detachAll();
  g.chrome = saved;
});

describe('tryAttachToTab', () => {
  it('detaches before retrying when a domain fails to enable', async () => {
    const f = fakeChrome({ failOnce: { 'Runtime.enable': 'Runtime.enable timed out' } });
    g.chrome = f.chrome;
    const r = await tryAttachToTab(1);
    expect(r.session?.isAttached).toBe(true);
    // attach → Page.enable → Runtime.enable (fails) → detach → attach again
    expect(f.calls.slice(0, 4)).toEqual(['attach', 'Page.enable', 'Runtime.enable', 'detach']);
    expect(f.calls.filter((c) => c === 'attach')).toHaveLength(2);
  });

  it('frees an orphaned attachment of its own and retries', async () => {
    const f = fakeChrome({ attachError: 'Another debugger is already attached to the tab with id: 1.' });
    g.chrome = f.chrome;
    const r = await tryAttachToTab(1);
    expect(r.session?.isAttached).toBe(true);
    expect(f.calls.slice(0, 2)).toEqual(['attach', 'detach']);
  });

  it('shares one attach between parallel callers', async () => {
    const f = fakeChrome();
    g.chrome = f.chrome;
    const [a, b] = await Promise.all([tryAttachToTab(1), tryAttachToTab(1)]);
    expect(a.session).toBe(b.session!);
    expect(f.calls.filter((c) => c === 'attach')).toHaveLength(1);
  });

  it('turns the Network domain off only when its last user leaves', async () => {
    const f = fakeChrome();
    g.chrome = f.chrome;
    const s = (await tryAttachToTab(1)).session!;
    await s.useNetwork('record:a', { maxPostDataSize: 1 });
    await s.useNetwork('emulate');
    await s.releaseNetwork('record:a');
    expect(f.calls).not.toContain('Network.disable');
    await s.releaseNetwork('emulate');
    expect(f.calls.filter((c) => c === 'Network.disable')).toHaveLength(1);
    expect(f.calls.filter((c) => c === 'Network.enable')).toHaveLength(1);
  });
});
