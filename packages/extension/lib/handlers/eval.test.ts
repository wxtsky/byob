import { test, expect, beforeEach, afterEach } from 'bun:test';

// We test the *fallback decision* in isolation — when tryAttachToTab returns
// reason: 'attach_failed', the handler must invoke chrome.scripting and set
// fallbackUsed:true. We stub the chrome global with the minimum surface area.

let originalChrome: unknown;

beforeEach(() => {
  originalChrome = (globalThis as { chrome?: unknown }).chrome;
  (globalThis as { chrome: unknown }).chrome = {
    tabs: {
      get: async (_id: number) => ({ id: _id, url: 'https://example.com' }),
      query: async () => [{ id: 99, active: true }],
      onRemoved: { addListener: () => {} },
    },
    cookies: { getAll: async () => [] },
    debugger: {
      attach: () => {
        const err: Error & { message: string } = new Error('cdp_attach_failed');
        throw err;
      },
      detach: () => {
        /* noop */
      },
      sendCommand: () => {
        /* noop */
      },
      onDetach: { addListener: () => {} },
      onEvent: { addListener: () => {} },
    },
    notifications: { create: () => {} },
    runtime: { getURL: () => '/icon/128.png', lastError: undefined },
    scripting: {
      executeScript: async () =>
        [{ result: 42, frameId: 0, documentId: 'd' }] as unknown as Array<{ result: number }>,
    },
  };
});

afterEach(() => {
  (globalThis as { chrome?: unknown }).chrome = originalChrome;
});

test('handleEval: attach_failed falls back to chrome.scripting and sets fallbackUsed:true', async () => {
  const { handleEval } = await import('./eval.js');
  const ac = new AbortController();
  const out = (await handleEval(
    { code: '1+1', tabId: 99, awaitPromise: true, returnByValue: true, framePath: [] },
    ac.signal,
  )) as Record<string, unknown>;
  expect(out.fallbackUsed).toBe(true);
  expect(out.result).toBe(42);
});

test('handleEval: aborted signal throws AbortError before CDP attempt', async () => {
  const { handleEval } = await import('./eval.js');
  const ac = new AbortController();
  ac.abort('aborted');
  let caught: unknown;
  try {
    await handleEval(
      { code: '1+1', tabId: 99, awaitPromise: true, returnByValue: true, framePath: [] },
      ac.signal,
    );
  } catch (e) {
    caught = e;
  }
  expect((caught as { name?: string })?.name).toBe('AbortError');
});
