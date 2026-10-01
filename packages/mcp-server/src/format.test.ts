import { describe, expect, test } from 'bun:test';
import { renderAction, renderRead, renderSnapshot } from './format.js';
import { stepText } from './tools/batch.js';
import type { ToolSpec } from './tools/_factory.js';

const tab = { tabId: 7, url: 'https://example.com/', title: 'Example' };

describe('renderSnapshot', () => {
  test('says when containers were cut at maxDepth', () => {
    const r = renderSnapshot({ ...tab, text: '- main:\n  - list', truncated: true }, { maxDepth: 4 });
    expect(r.text).toContain('deeper content cut at maxDepth 4');
  });

  test('defaults the depth in the note and stays quiet when the size notice is there', () => {
    expect(renderSnapshot({ ...tab, text: '- main', truncated: true }).text).toContain('maxDepth 12');
    const sized = renderSnapshot({ ...tab, text: '- a\n[… 9 more nodes not shown — …]', truncated: true });
    expect(sized.text).not.toContain('deeper content');
    expect(renderSnapshot({ ...tab, text: '- a', truncated: false }).text).not.toContain('deeper content');
  });
});

describe('renderRead links', () => {
  const links = Array.from({ length: 300 }, (_, i) => ({ text: `Item ${i}`, url: `https://example.com/p/${i}` }));
  links.push({ text: 'Pricing', url: 'https://example.com/pricing' });

  test('filter matches text or URL, case-insensitively', () => {
    const r = renderRead({ ...tab, format: 'links', links }, { filter: 'PRICING' });
    expect(r.text).toContain('1 of 301 links match "PRICING"');
    expect(r.text).toContain('- Pricing → https://example.com/pricing');
    expect(r.text).not.toContain('Item 1 ');
  });

  test('maxChars caps the list and says how many are left', () => {
    const r = renderRead({ ...tab, format: 'links', links }, { maxChars: 1000 });
    expect(r.text.length).toBeLessThan(1400);
    expect(r.text).toMatch(/… \d+ more links \(use filter, or scope with ref\/selector\)/);
  });
});

describe('batch step text', () => {
  const action = { name: 'browser_click', compactInBatch: true, render: renderAction } as unknown as ToolSpec;

  test('an action keeps its summary + effects, notes the cut, and keeps its own snapshot whole', () => {
    const res = {
      ...tab,
      summary: 'Clicked button "Open"',
      effects: { newTabs: [1, 2, 3, 4, 5].map((t) => ({ tabId: 100 + t, url: `https://x/${t}` })) },
      snapshot: { ...tab, text: '- button "A" [ref=e1]\n- button "B" [ref=e2]' },
    };
    const text = stepText(action, res, {}, []);
    expect(text.split('\n')[0]).toBe('Clicked button "Open" (tab 7)');
    expect(text).toContain('(+2 more lines)');
    expect(text).toContain('- button "B" [ref=e2]');
  });

  test('other tools stay whole and hand over their images', () => {
    const lines = Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n');
    const obs = { name: 'browser_tabs', render: () => ({ text: lines, images: [{ data: 'AA', mimeType: 'image/png' }] }) } as unknown as ToolSpec;
    const images: Array<{ data: string; mimeType: string }> = [];
    expect(stepText(obs, {}, {}, images)).toBe(lines);
    expect(images).toHaveLength(1);
  });
});
