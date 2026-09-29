import { describe, expect, it } from 'bun:test';
import { createKeyedLock, lockKeyFor, type TabResolvers } from '../tab-lock.js';

const tick = () => new Promise((r) => setTimeout(r, 1));

describe('keyed lock', () => {
  it('runs holders of one key strictly in arrival order', async () => {
    const lock = createKeyedLock<number>();
    const order: string[] = [];
    const job = async (name: string, ms: number) => {
      const release = await lock.acquire(1, new AbortController().signal);
      order.push(`${name}+`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`${name}-`);
      release();
    };
    await Promise.all([job('a', 15), job('b', 1), job('c', 5)]);
    expect(order).toEqual(['a+', 'a-', 'b+', 'b-', 'c+', 'c-']);
    expect(lock.busy(1)).toBe(false);
  });

  it('different keys do not wait for each other', async () => {
    const lock = createKeyedLock<number>();
    const r1 = await lock.acquire(1, new AbortController().signal);
    const r2 = await lock.acquire(2, new AbortController().signal);
    r1();
    r2();
  });

  it('an aborted waiter leaves the queue without blocking the ones behind it', async () => {
    const lock = createKeyedLock<number>();
    const first = await lock.acquire(1, new AbortController().signal);
    const ac = new AbortController();
    const second = lock.acquire(1, ac.signal);
    let thirdIn = false;
    const third = lock.acquire(1, new AbortController().signal).then((rel) => { thirdIn = true; return rel; });
    ac.abort('aborted');
    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    await tick();
    expect(thirdIn).toBe(false); // still behind `first`
    first();
    (await third)();
    expect(thirdIn).toBe(true);
    await tick();
    expect(lock.busy(1)).toBe(false);
  });

  it('an already-aborted signal is refused at once; release is idempotent', async () => {
    const lock = createKeyedLock<number>();
    const held = await lock.acquire(1, new AbortController().signal);
    const ac = new AbortController();
    ac.abort();
    await expect(lock.acquire(1, ac.signal)).rejects.toMatchObject({ name: 'AbortError' });
    held();
    held();
    const next = await lock.acquire(1, new AbortController().signal);
    next();
  });
});

describe('lockKeyFor', () => {
  const r: TabResolvers = {
    tabOfRef: (ref) => (ref === 'e7' ? 42 : undefined),
    activeTabId: async () => 9,
  };
  it('meta commands, dialogs and waits take no lock', async () => {
    for (const c of ['tabs', 'console', 'clipboard', 'policy', 'dialog', 'wait']) {
      expect(await lockKeyFor(c, { tabId: 3 }, r)).toBeNull();
    }
  });
  it('picks the tab like the handlers: tabId, then the ref owner, then the active tab', async () => {
    expect(await lockKeyFor('click', { tabId: 3, ref: 'e7' }, r)).toBe(3);
    expect(await lockKeyFor('click', { ref: '[ref=e7]' }, r)).toBe(42);
    expect(await lockKeyFor('find', { within: 'e7' }, r)).toBe(42);
    expect(await lockKeyFor('drag', { from: { selector: '#a' }, to: { ref: 'e7' } }, r)).toBe(42);
    expect(await lockKeyFor('click', { ref: 'e99' }, r)).toBe(9);
    expect(await lockKeyFor('snapshot', {}, r)).toBe(9);
  });
  it('calls that open their URL in a new tab take no lock', async () => {
    expect(await lockKeyFor('navigate', { url: 'https://a.b' }, r)).toBeNull();
    expect(await lockKeyFor('navigate', { url: 'https://a.b', tabId: 3, newTab: true }, r)).toBeNull();
    expect(await lockKeyFor('navigate', { url: 'https://a.b', tabId: 3 }, r)).toBe(3);
    expect(await lockKeyFor('navigate', { action: 'back', tabId: 3 }, r)).toBe(3);
    expect(await lockKeyFor('read', { url: 'https://a.b' }, r)).toBeNull();
    expect(await lockKeyFor('screenshot', { url: 'https://a.b', tabId: 5 }, r)).toBe(5);
  });
});
