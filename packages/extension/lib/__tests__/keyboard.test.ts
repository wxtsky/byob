import { describe, expect, it } from 'bun:test';
import { parseCombo } from '../input/keyboard.js';

describe('parseCombo', () => {
  it('parses modifiers and aliases', () => {
    expect(parseCombo('Control+Shift+K')).toEqual({ modifiers: ['Control', 'Shift'], key: 'K' });
    expect(parseCombo('Meta+K')).toEqual({ modifiers: ['Meta'], key: 'k' });
    expect(parseCombo('ctrl+a')).toEqual({ modifiers: ['Control'], key: 'a' });
    expect(parseCombo('esc')).toEqual({ modifiers: [], key: 'Escape' });
    expect(parseCombo('Enter')).toEqual({ modifiers: [], key: 'Enter' });
  });
  it('supports a literal plus key', () => {
    expect(parseCombo('Control++')).toEqual({ modifiers: ['Control'], key: '+' });
    expect(parseCombo('+')).toEqual({ modifiers: [], key: '+' });
  });
  it('rejects unknown keys and non-modifier prefixes', () => {
    expect(() => parseCombo('Hyper')).toThrow(/Unknown key/);
    expect(() => parseCombo('a+b')).toThrow(/not a modifier/);
  });
});
