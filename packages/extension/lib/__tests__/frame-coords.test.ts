import { describe, it, expect } from 'bun:test';
import { _accumulateOffset, _composeFinalCoords } from '../frame-coords.js';

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
