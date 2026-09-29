import { describe, expect, it } from 'bun:test';
import { SENSITIVE_PREDICATE_SRC } from '../sensitive.js';

// Exercise the exact source that gets shipped to the page, not a TypeScript
// twin of it — a twin is the thing that passes tests while the page runs
// something else.
const hasSensitiveValue = new Function(
  `${SENSITIVE_PREDICATE_SRC}; return hasSensitiveValue;`,
)() as (el: { getAttribute(name: string): string | null }) => boolean;

/** Minimal stand-in for the element the in-page collector sees. */
function el(attrs: Record<string, string>): { getAttribute(name: string): string | null } {
  return { getAttribute: (n: string) => attrs[n] ?? null };
}

describe('sensitive-field redaction', () => {
  it('flags credential inputs by type', () => {
    expect(hasSensitiveValue(el({ type: 'password' }))).toBe(true);
    expect(hasSensitiveValue(el({ type: 'email' }))).toBe(true);
    expect(hasSensitiveValue(el({ type: 'tel' }))).toBe(true);
  });

  it('flags one-time-code autocomplete', () => {
    expect(hasSensitiveValue(el({ type: 'text', autocomplete: 'one-time-code' }))).toBe(true);
  });

  it('flags fields whose naming attributes read as credentials', () => {
    expect(hasSensitiveValue(el({ type: 'text', name: 'user_password' }))).toBe(true);
    expect(hasSensitiveValue(el({ type: 'text', id: 'otpCode' }))).toBe(true);
    expect(hasSensitiveValue(el({ type: 'text', 'aria-label': 'Card number' }))).toBe(true);
    expect(hasSensitiveValue(el({ type: 'text', name: 'cvv' }))).toBe(true);
    expect(hasSensitiveValue(el({ type: 'text', autocomplete: 'cc-number' }))).toBe(true);
    expect(hasSensitiveValue(el({ type: 'text', placeholder: '2FA code' }))).toBe(true);
  });

  it('leaves ordinary fields alone', () => {
    expect(hasSensitiveValue(el({ type: 'text', name: 'search' }))).toBe(false);
    expect(hasSensitiveValue(el({ type: 'text', id: 'q' }))).toBe(false);
    expect(hasSensitiveValue(el({ type: 'search', 'aria-label': 'Search repositories' }))).toBe(false);
    expect(hasSensitiveValue(el({}))).toBe(false);
  });
});
