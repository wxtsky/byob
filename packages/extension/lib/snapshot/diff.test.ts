import { describe, expect, it } from 'bun:test';
import { diffLines, renderDiff } from './diff.js';

describe('diffLines', () => {
  it('is empty-edit for equal input', () => {
    expect(diffLines(['a', 'b'], ['a', 'b']).every((o) => o.kind === '=')).toBe(true);
  });
  it('finds a minimal edit', () => {
    const ops = diffLines(['a', 'b', 'c'], ['a', 'x', 'c', 'd']);
    expect(ops.filter((o) => o.kind !== '=').map((o) => o.kind + o.line)).toEqual(['-b', '+x', '+d']);
  });
  it('handles empty sides', () => {
    expect(diffLines([], ['a']).map((o) => o.kind)).toEqual(['+']);
    expect(diffLines(['a'], []).map((o) => o.kind)).toEqual(['-']);
  });
});

describe('renderDiff', () => {
  it('anchors a change under its nearest unchanged ancestor', () => {
    const prev = ['- main:', '  - button "Save" [ref=e1]', '- footer'];
    const next = ['- main:', '  - button "Saved" [ref=e1, disabled]', '- footer'];
    const d = renderDiff(prev, next);
    expect(d.text).toBe('  - main:\n-   - button "Save" [ref=e1]\n+   - button "Saved" [ref=e1, disabled]');
    expect([d.added, d.removed, d.unchanged]).toEqual([1, 1, false]);
  });
  it('reports unchanged', () => {
    expect(renderDiff(['- a'], ['- a']).unchanged).toBe(true);
  });
});
