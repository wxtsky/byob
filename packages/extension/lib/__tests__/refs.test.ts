import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { _resetRefsForTests, lookupRef, normalizeRef, refFor, restoreRefCounter, tabOfRef } from '../refs.js';

const base = { frameId: 'F', loaderId: 'L1', role: 'button', name: 'Go', nth: 0 };

describe('refs', () => {
  beforeEach(() => _resetRefsForTests());
  it('is stable for the same node and never reused', () => {
    const a = refFor(1, { ...base, backendNodeId: 10 });
    const b = refFor(1, { ...base, backendNodeId: 11 });
    expect(refFor(1, { ...base, backendNodeId: 10 })).toBe(a);
    expect(a).not.toBe(b);
  });
  it('mints a new ref when the document changes', () => {
    const a = refFor(1, { ...base, backendNodeId: 10 });
    const b = refFor(1, { ...base, backendNodeId: 10, loaderId: 'L2' });
    expect(b).not.toBe(a);
  });
  it('knows which tab minted a ref', () => {
    const r = refFor(7, { ...base, backendNodeId: 1 });
    expect(tabOfRef(r)).toBe(7);
    expect(lookupRef(7, r)?.backendNodeId).toBe(1);
  });
  it('normalizes the spellings agents use', () => {
    for (const s of ['e12', '@e12', 'ref=e12', '[ref=e12]', ' E12 ']) expect(normalizeRef(s)).toBe('e12');
    expect(normalizeRef('button')).toBeNull();
  });
});

describe('ref counter across worker restarts', () => {
  const stored: Record<string, unknown> = {};
  const g = globalThis as { chrome?: unknown };
  let saved: unknown;
  beforeEach(() => {
    _resetRefsForTests();
    for (const k of Object.keys(stored)) delete stored[k];
    saved = g.chrome;
    g.chrome = {
      storage: {
        local: {
          get: async (k: string) => (k in stored ? { [k]: stored[k] } : {}),
          set: async (o: Record<string, unknown>) => void Object.assign(stored, o),
        },
      },
    };
  });
  afterEach(() => {
    g.chrome = saved;
  });

  it('persists a block above every ref it hands out', async () => {
    const r = refFor(1, { ...base, backendNodeId: 1 });
    await Promise.resolve();
    expect(Number(r.slice(1))).toBeLessThan(stored.refHighWater as number);
  });

  it('starts above the persisted high-water mark after a restart', async () => {
    stored.refHighWater = 4000;
    await restoreRefCounter();
    expect(refFor(1, { ...base, backendNodeId: 1 })).toBe('e4000');
    expect(stored.refHighWater as number).toBeGreaterThan(4000);
  });
});
