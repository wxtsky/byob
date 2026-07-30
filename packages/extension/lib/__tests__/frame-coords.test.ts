import { describe, it, expect } from 'bun:test';
import { _accumulateOffset, _composeFinalCoords, toPageCoords } from '../frame-coords.js';
import type { ResolvedFrame } from '../frame-resolver.js';

describe('_accumulateOffset (pure math)', () => {
  it('returns (0,0) for empty rect chain (main frame)', () => {
    const rects: Array<{ x: number; y: number }> = [];
    expect(_accumulateOffset(rects)).toEqual({ x: 0, y: 0 });
  });

  it('returns the rect itself for one iframe', () => {
    const rects = [{ x: 100, y: 200 }];
    expect(_accumulateOffset(rects)).toEqual({ x: 100, y: 200 });
  });

  it('sums offsets across nested iframes', () => {
    const rects = [
      { x: 50, y: 60 },
      { x: 10, y: 20 },
    ];
    expect(_accumulateOffset(rects)).toEqual({ x: 60, y: 80 });
  });

  it('handles three levels', () => {
    const rects = [
      { x: 5, y: 5 },
      { x: 10, y: 10 },
      { x: 15, y: 15 },
    ];
    expect(_accumulateOffset(rects)).toEqual({ x: 30, y: 30 });
  });

  it('accepts negative offsets (iframe scrolled out of parent)', () => {
    const rects = [
      { x: -20, y: -30 },
      { x: 50, y: 60 },
    ];
    expect(_accumulateOffset(rects)).toEqual({ x: 30, y: 30 });
  });
});

describe('_composeFinalCoords', () => {
  it('returns center of element + accumulated offset', () => {
    const offsets = [{ x: 100, y: 200 }];
    const elementRect = { x: 30, y: 40, width: 20, height: 10 };
    const out = _composeFinalCoords(offsets, elementRect);
    expect(out).toEqual({ x: 140, y: 245 });
  });

  it('rounds to integer page pixels', () => {
    const offsets = [{ x: 100.7, y: 200.3 }];
    const elementRect = { x: 30.4, y: 40.6, width: 20, height: 10 };
    const out = _composeFinalCoords(offsets, elementRect);
    expect(out).toEqual({ x: 141, y: 246 });
  });
});

describe('toPageCoords settles the element before reading its rect', () => {
  const frame: ResolvedFrame = { frameId: 'main', contextId: 1 };
  const capture = () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const session = {
      send: async <T,>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
        calls.push({ method, params });
        return {
          result: { value: { x: 10, y: 20, width: 30, height: 40, text: 'ok' } },
        } as T;
      },
      sendOnSession: async <T,>(
        _sessionId: string,
        method: string,
        params: Record<string, unknown> = {},
      ): Promise<T> => {
        calls.push({ method, params });
        return {
          result: { value: { x: 10, y: 20, width: 30, height: 40, text: 'ok' } },
        } as T;
      },
    };
    return { session, calls };
  };

  it('awaits the in-page promise instead of reading a mid-scroll rect', async () => {
    const { session, calls } = capture();
    await toPageCoords(session, [], frame, '#go', async () => frame);

    const evaluate = calls.find((c) => c.method === 'Runtime.evaluate');
    expect(evaluate).toBeDefined();
    // Regression guard: the rect used to be read in the same tick as
    // scrollIntoView, so a page with `scroll-behavior: smooth` produced
    // pre-scroll coordinates and the click landed somewhere else.
    expect(evaluate!.params.awaitPromise).toBe(true);

    const expr = String(evaluate!.params.expression);
    expect(expr).toContain("behavior: 'instant'");
    expect(expr).toContain('requestAnimationFrame');
    expect(expr).toContain('stableFrames >= 2');
  });

  it('still returns the composed centre point', async () => {
    const { session } = capture();
    const out = await toPageCoords(session, [], frame, '#go', async () => frame);
    expect(out).toEqual({ xy: { x: 25, y: 40 }, elementText: 'ok' });
  });
});
