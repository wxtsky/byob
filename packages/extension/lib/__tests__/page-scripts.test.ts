import { describe, expect, it } from 'bun:test';
import { EXTRACT_FN, HTML_FN, LAZY_SCROLL_FN, LINKS_FN, READABILITY_INSTALL } from '../extract.js';
import { PROBE_FN } from '../dom/element.js';
import { SELECT_FN, SCROLL_FN, SIM_DND_FN } from '../handlers/interact.js';
import { ELEMENT_INFO_FN } from '../handlers/state.js';
import { DOM_FIND_FN } from '../handlers/find.js';
import { READ_VALUE_FN, SELECT_ALL_FN, SET_VALUE_FN } from '../handlers/type.js';

// These run inside the page, shipped as source text. Two ways they break
// without any type checker noticing: a syntax error, or a template literal
// eating a regex backslash (`/\s+/` silently becomes `/s+/`, which replaces
// the letter "s" — a real bug this test was written after).
const SCRIPTS: Record<string, string> = {
  EXTRACT_FN, HTML_FN, LAZY_SCROLL_FN, LINKS_FN, PROBE_FN, SELECT_FN, SCROLL_FN, SIM_DND_FN,
  ELEMENT_INFO_FN, DOM_FIND_FN, READ_VALUE_FN, SELECT_ALL_FN, SET_VALUE_FN,
};

describe('in-page scripts', () => {
  for (const [name, src] of Object.entries(SCRIPTS)) {
    it(`${name} parses as a function`, () => {
      expect(() => new Function(`return (${src});`)).not.toThrow();
    });
    it(`${name} kept its regex escapes`, () => {
      expect(src).not.toMatch(/[/[(|]s[+*]/);
      expect(src).not.toMatch(/[/[(|]d[+*]/);
      expect(src).not.toMatch(/[/[(|]w[+*]/);
    });
  }
  it('READABILITY_INSTALL is a valid expression embedding the library', () => {
    expect(READABILITY_INSTALL).toContain('function Readability');
    expect(() => new Function(`return ${READABILITY_INSTALL};`)).not.toThrow();
  });
});
