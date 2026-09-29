import { describe, expect, it } from 'bun:test';
import { filterSections, outlineOf } from '../handlers/read.js';

const doc = '# Title\nintro\n## Pricing\n42 dollars\n## FAQ\nquestions\n### Refunds\nno pricing talk here';

describe('outline / filter', () => {
  it('outlines headings by level', () => {
    expect(outlineOf(doc)).toBe('- Title\n  - Pricing\n  - FAQ\n    - Refunds');
  });
  it('keeps matching sections with their breadcrumb', () => {
    const out = filterSections(doc, 'PRICING');
    expect(out).toContain('## Pricing\n42 dollars');
    expect(out).toContain('[Title › FAQ]\n### Refunds');
    expect(out).not.toContain('questions');
  });
  it('falls back to lines with context when there are no headings', () => {
    expect(filterSections('a\nb target\nc\nd', 'target')).toBe('a\nb target\nc');
  });
});
