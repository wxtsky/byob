import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { clean, errorData, fitJson } from './json-output.js';

describe('clean', () => {
  test('drops internal fields at any depth and keeps the rest', () => {
    expect(clean({ tabId: 1, _b64Data: 'AAAA', diff: { boxes: [{ x: 1 }], _px: 2 }, list: [{ a: 1, _b: 2 }] }))
      .toEqual({ tabId: 1, diff: { boxes: [{ x: 1 }] }, list: [{ a: 1 }] });
  });
});

describe('errorData', () => {
  test('code, message and hint first; internal fields renamed or dropped', () => {
    const e = errorData({ error: 'unknown', message: 'boom', hint: 'retry', reason: 'x', aborted: undefined, _originalError: 'weird_code' });
    expect(e).toEqual({ error: 'unknown', message: 'boom', hint: 'retry', reason: 'x', originalError: 'weird_code' });
    expect(Object.keys(e).slice(0, 3)).toEqual(['error', 'message', 'hint']);
  });
});

describe('fitJson', () => {
  test('small results are plain JSON', () => {
    expect(JSON.parse(fitJson('browser_x', { a: 1, s: 'hi' }))).toEqual({ a: 1, s: 'hi' });
  });

  test('a long string is cut, the shape kept, and the whole result saved', () => {
    const out = fitJson('browser_evaluate', { valueType: 'string', value: 'x'.repeat(50_000) }, 10_000);
    expect(out.length).toBeLessThanOrEqual(10_000);
    const r = JSON.parse(out);
    expect(r.valueType).toBe('string');
    expect(r.value).toMatch(/^x+… \[\d+ more chars\]$/);
    expect(r._truncated.chars).toBeGreaterThan(50_000);
    expect(JSON.parse(fs.readFileSync(r._truncated.file, 'utf-8')).value).toHaveLength(50_000);
  });

  test('a long array of small items is cut too', () => {
    const records = Array.from({ length: 20_000 }, (_, i) => ({ url: `https://example.com/${i}`, status: 200 }));
    const r = JSON.parse(fitJson('browser_network', { records }, 20_000));
    expect(r.records.length).toBeGreaterThan(0);
    expect(r.records.length).toBeLessThan(20_000);
    expect(r.records[0]).toEqual({ url: 'https://example.com/0', status: 200 });
    expect(fs.existsSync(r._truncated.file)).toBe(true);
  });

  test('a top-level array keeps its items under value', () => {
    const r = JSON.parse(fitJson('browser_x', Array.from({ length: 5000 }, () => 'y'.repeat(50)), 5_000));
    expect(Array.isArray(r.value)).toBe(true);
    expect(r._truncated).toBeDefined();
  });
});
