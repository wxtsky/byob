import { describe, expect, test } from 'bun:test';
import { compileUrlPattern, matchUrl } from '../url-pattern.js';

describe('compileUrlPattern', () => {
  test('returns null for empty / undefined input', () => {
    expect(compileUrlPattern(undefined)).toBeNull();
    expect(compileUrlPattern('')).toBeNull();
  });

  test('treats /.../ delimited input as regex', () => {
    const m = compileUrlPattern('/api\\/v\\d+/');
    expect(m).not.toBeNull();
    expect(matchUrl(m, 'https://x.com/api/v2/users')).toBe(true);
    expect(matchUrl(m, 'https://x.com/static/main.js')).toBe(false);
  });

  test('regex with flags: /.../i', () => {
    const m = compileUrlPattern('/API/i');
    expect(matchUrl(m, 'https://x.com/api/users')).toBe(true);
  });

  test('treats other input as glob with * wildcard', () => {
    const m = compileUrlPattern('*api*');
    expect(matchUrl(m, 'https://x.com/api/v2/users')).toBe(true);
    expect(matchUrl(m, 'https://x.com/static/main.js')).toBe(false);
  });

  test('glob is case-sensitive', () => {
    const m = compileUrlPattern('*API*');
    expect(matchUrl(m, 'https://x.com/api/users')).toBe(false);
  });

  test('glob with anchored prefix and suffix', () => {
    const m = compileUrlPattern('https://api.example.com/*');
    expect(matchUrl(m, 'https://api.example.com/v1/foo')).toBe(true);
    expect(matchUrl(m, 'https://other.com/api.example.com/x')).toBe(false);
  });

  test('matchUrl returns true when pattern is null (no filter)', () => {
    expect(matchUrl(null, 'anything')).toBe(true);
  });

  test('invalid regex falls back to literal-glob safely (no throw)', () => {
    const m = compileUrlPattern('/[unclosed/');
    expect(typeof m).toBe('object');
  });
});
