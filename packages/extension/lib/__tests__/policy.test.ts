import { describe, expect, it } from 'bun:test';
import { looseningChanges } from '../handlers/policy.js';

const base = { allowedDomains: [] as string[], deniedDomains: ['**.bank.com'], allowFile: false, allowAuthDomains: false };

describe('looseningChanges', () => {
  it('treats tightening as safe', () => {
    expect(looseningChanges(base, { deniedDomains: ['**.bank.com', 'mail.x.com'] })).toEqual([]);
    expect(looseningChanges(base, { allowedDomains: ['**.github.com'] })).toEqual([]);
    expect(looseningChanges({ ...base, allowFile: true }, { allowFile: false })).toEqual([]);
  });
  it('flags every way of widening access', () => {
    expect(looseningChanges(base, { deniedDomains: [] })).toEqual(['Stop blocking: **.bank.com']);
    expect(looseningChanges({ ...base, allowedDomains: ['a.com'] }, { allowedDomains: [] })).toEqual(['Remove the allowlist (allow every site)']);
    expect(looseningChanges({ ...base, allowedDomains: ['a.com'] }, { allowedDomains: ['a.com', 'b.com'] })).toEqual(['Also allow: b.com']);
    expect(looseningChanges(base, { allowFile: true, allowAuthDomains: true })).toHaveLength(2);
  });
});
