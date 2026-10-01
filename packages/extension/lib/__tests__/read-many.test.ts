import { describe, expect, it } from 'bun:test';
import { pageBudget, pdfToText } from '../handlers/read.js';
import { lockKeyFor } from '../tab-lock.js';

describe('per-page budget', () => {
  it('splits the default between pages, never below the floor', () => {
    expect(pageBudget('text', undefined)).toBe(20_000);
    expect(pageBudget('html', undefined)).toBe(60_000);
    expect(pageBudget('text', undefined, 4)).toBe(5_000);
    expect(pageBudget('text', undefined, 10)).toBe(3_000);
    expect(pageBudget('html', undefined, 10)).toBe(6_000);
  });
  it('treats an explicit maxChars as per page', () => {
    expect(pageBudget('text', 8_000, 5)).toBe(8_000);
  });
});

describe('PDF text', () => {
  const pages = ['Report\nRevenue grew', 'Appendix\nzebras live here', ''];
  it('marks every page', () => {
    expect(pdfToText(pages)).toBe('--- page 1 ---\nReport\nRevenue grew\n\n--- page 2 ---\nAppendix\nzebras live here\n\n--- page 3 ---\n');
  });
  it('filters to the pages that mention the text', () => {
    const f = pdfToText(pages, { filter: 'ZEBRAS' });
    expect(f).toStartWith('--- page 2 ---');
    expect(f).not.toContain('Revenue');
    expect(pdfToText(pages, { filter: 'nothing' })).toBe('(no page mentions "nothing")');
  });
  it('outlines by first line', () => {
    expect(pdfToText(pages, { outline: true })).toBe('- page 1: Report\n- page 2: Appendix\n- page 3: (empty)');
  });
});

describe('tab lock', () => {
  it('does not lock any tab for a multi-URL read (it only uses tabs it opens)', async () => {
    const r = { activeTabId: async () => 1, tabOfRef: () => undefined };
    expect(await lockKeyFor('read', { urls: ['https://a.test'], tabId: 5 }, r)).toBeNull();
  });
});
