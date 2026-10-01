import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  _resetActivityForTests,
  beginActivity,
  endActivity,
  hostOf,
  inFlightCount,
  recentActivity,
} from '../activity.js';
import { pauseGate } from '../pause.js';
import { _resetHandoffsForTests, answerHandoff, pendingHandoffs, waitForUser } from '../handoff.js';
import { badgeFor } from '../toolbar.js';

describe('activity log', () => {
  beforeEach(() => _resetActivityForTests());

  it('keeps the command, tab and hostname — never the URL path or query', () => {
    const e = beginActivity('navigate', 7);
    expect(inFlightCount()).toBe(1);
    endActivity(e, { ok: true, url: 'https://mail.example.com/inbox?token=secret#x' });
    const [a] = recentActivity();
    expect(a).toMatchObject({ command: 'navigate', tabId: 7, host: 'mail.example.com', ok: true });
    expect(JSON.stringify(a)).not.toContain('secret');
    expect(JSON.stringify(a)).not.toContain('inbox');
    expect(inFlightCount()).toBe(0);
  });

  it('is a bounded ring, newest first, that still counts calls scrolled out of it', () => {
    const first = beginActivity('wait');
    for (let i = 0; i < 80; i++) endActivity(beginActivity(`c${i}`), { ok: true });
    const list = recentActivity();
    expect(list).toHaveLength(50);
    expect(list[0]!.command).toBe('c79');
    expect(inFlightCount()).toBe(1);
    endActivity(first, { ok: false, errorCode: 'timeout' });
    expect(inFlightCount()).toBe(0);
  });

  it('reduces URLs to their host', () => {
    expect(hostOf('file:///Users/me/a.html')).toBe('file');
    expect(hostOf('not a url')).toBeUndefined();
  });
});

describe('pause gate', () => {
  it('refuses browser commands while paused, with a hint for the agent', () => {
    expect(pauseGate('click', false)).toBeNull();
    const e = pauseGate('click', true);
    expect(e?.code).toBe('paused');
    expect(e?.hint).toContain('Resume');
    expect(pauseGate('wait', true)?.code).toBe('paused');
  });

  it("lets the user's own CLI through", () => {
    expect(pauseGate('policy', true)).toBeNull();
  });
});

describe('badge', () => {
  it('shows the most important state', () => {
    expect(badgeFor({ paused: true, handoffs: 1, running: 2 }).text).toBe('!');
    expect(badgeFor({ paused: true, handoffs: 0, running: 2 }).text).toBe('II');
    expect(badgeFor({ paused: false, handoffs: 0, running: 1 }).text).toBe(' ');
    expect(badgeFor({ paused: false, handoffs: 0, running: 0 }).text).toBe('');
  });
});

describe('handoff', () => {
  const g = globalThis as { chrome?: unknown };
  let saved: unknown;
  beforeEach(() => {
    _resetHandoffsForTests();
    saved = g.chrome;
    g.chrome = { runtime: { getURL: (p: string) => `chrome-extension://x/${p}`, lastError: undefined } };
  });
  afterEach(() => {
    g.chrome = saved;
  });
  const signal = (): AbortSignal => new AbortController().signal;

  it('resolves with the answer the user gives', async () => {
    const p = waitForUser(1, 'Sign in', 5000, signal(), { focus: false });
    await Promise.resolve();
    const [h] = pendingHandoffs();
    expect(h!.message).toBe('Sign in');
    expect(answerHandoff(h!.id, 'done')).toBe(true);
    expect(await p).toBe('done');
    expect(pendingHandoffs()).toHaveLength(0);
  });

  it('times out as pending, keeps the request, and hands a later answer to the next wait', async () => {
    expect(await waitForUser(2, 'Solve the CAPTCHA', 20, signal(), { focus: false })).toBe('pending');
    const [h] = pendingHandoffs();
    answerHandoff(h!.id, 'declined');
    expect(await waitForUser(2, 'Solve the CAPTCHA', 5000, signal(), { focus: false })).toBe('declined');
  });

  it('rejects on abort but leaves the request open', async () => {
    const ac = new AbortController();
    const p = waitForUser(3, 'Approve the payment', 5000, ac.signal, { focus: false });
    ac.abort();
    await expect(p).rejects.toThrow();
    expect(pendingHandoffs()).toHaveLength(1);
  });

  it('ignores unknown or already answered ids', () => {
    expect(answerHandoff('nope', 'done')).toBe(false);
  });
});
