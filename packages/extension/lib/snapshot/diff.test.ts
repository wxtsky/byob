import { describe, expect, it } from 'bun:test';
import { diffLines, renderDiff } from './diff.js';

describe('diffLines', () => {
  it('is empty-edit for equal input', () => {
    expect(diffLines(['a', 'b'], ['a', 'b'])!.every((o) => o.kind === '=')).toBe(true);
  });
  it('finds a minimal edit', () => {
    const ops = diffLines(['a', 'b', 'c'], ['a', 'x', 'c', 'd'])!;
    expect(ops.filter((o) => o.kind !== '=').map((o) => o.kind + o.line)).toEqual(['-b', '+x', '+d']);
  });
  it('gives up beyond the edit budget', () => {
    expect(diffLines(['a', 'b', 'c'], ['x', 'y', 'z'], 2)).toBeNull();
  });
  it('handles empty sides', () => {
    expect(diffLines([], ['a'])!.map((o) => o.kind)).toEqual(['+']);
    expect(diffLines(['a'], [])!.map((o) => o.kind)).toEqual(['-']);
  });
});

describe('renderDiff', () => {
  it('anchors a change under its nearest unchanged ancestor', () => {
    const prev = ['- main:', '  - button "Save" [ref=e1]', '- footer'];
    const next = ['- main:', '  - button "Saved" [ref=e1, disabled]', '- footer'];
    const d = renderDiff(prev, next)!;
    expect(d.text).toBe('  - main:\n-   - button "Save" [ref=e1]\n+   - button "Saved" [ref=e1, disabled]');
    expect([d.added, d.removed, d.unchanged]).toEqual([1, 1, false]);
  });
  it('reports unchanged', () => {
    expect(renderDiff(['- a'], ['- a'])!.unchanged).toBe(true);
  });
});

describe('diffLines on larger input', () => {
  it('matches a brute-force edit count on random edits', () => {
    const base = Array.from({ length: 400 }, (_, i) => `line ${i}`);
    const next = base.filter((_, i) => i % 7 !== 0).map((l, i) => (i % 11 === 0 ? l + ' changed' : l));
    const ops = diffLines(base, next)!;
    const rebuilt = ops.filter((o) => o.kind !== '-').map((o) => o.line);
    const original = ops.filter((o) => o.kind !== '+').map((o) => o.line);
    expect(rebuilt).toEqual(next);
    expect(original).toEqual(base);
  });
});
