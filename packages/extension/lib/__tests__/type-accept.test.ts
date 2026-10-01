import { describe, expect, it } from 'bun:test';
import { acceptedAs } from '../handlers/type.js';
import { COLLECTOR_INSTALL, COLLECTOR_UNINSTALL } from '../handlers/download-images.js';

describe('acceptedAs (did the field take the typed text?)', () => {
  it('exact, modulo whitespace', () => {
    expect(acceptedAs('hello  world', 'hello world', -1)).toBe('exact');
    expect(acceptedAs('', '', -1)).toBe('exact');
  });
  it('masks and case changes count as reformatted', () => {
    expect(acceptedAs('4242 4242 4242 4242', '4242424242424242', -1)).toBe('reformatted');
    expect(acceptedAs('(555) 123-4567', '5551234567', -1)).toBe('reformatted');
    expect(acceptedAs('ABC123', 'abc123', -1)).toBe('reformatted');
    expect(acceptedAs('张三', '张三', -1)).toBe('exact');
  });
  it('maxlength truncation', () => {
    expect(acceptedAs('abcde', 'abcdefgh', 5)).toBe('truncated');
    expect(acceptedAs('abcde', 'abcdefgh', -1)).toBeNull();
  });
  it('anything else is a failure', () => {
    expect(acceptedAs('', 'hello', -1)).toBeNull();
    expect(acceptedAs('old value', 'hello', -1)).toBeNull();
    expect(acceptedAs('01/05/2024', '2024-01-05', -1)).toBeNull();
  });
});

describe('download-images page scripts', () => {
  it('parse as programs', () => {
    expect(() => new Function(COLLECTOR_INSTALL)).not.toThrow();
    expect(() => new Function(COLLECTOR_UNINSTALL)).not.toThrow();
  });
});
