import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { classifyAttachUrl } from '../tab-access.js';
import { setAllowedFlags, setHostPolicy } from '../url-guard.js';

function resetGuardState(): void {
  setAllowedFlags({ BYOB_ALLOW_FILE: false, BYOB_ALLOW_AUTH_DOMAINS: false });
  setHostPolicy({ allowedDomains: [], deniedDomains: [] });
}

beforeEach(resetGuardState);
afterEach(resetGuardState);

describe('classifyAttachUrl', () => {
  test('classifies browser-internal protocols as special pages', () => {
    expect(classifyAttachUrl('chrome://settings')).toEqual({
      ok: false,
      reason: 'special_page',
      reasonDetail: 'protocol chrome: is forbidden',
    });
  });

  test('honors the file URL opt-in instead of rejecting it unconditionally', () => {
    setAllowedFlags({ BYOB_ALLOW_FILE: true });
    expect(classifyAttachUrl('file:///tmp/local.html')).toEqual({ ok: true });
  });

  test('enforces the built-in authentication-domain boundary for bare tab ids', () => {
    const result = classifyAttachUrl('https://accounts.google.com/signin');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('host_forbidden');
      expect(result.reasonDetail).toContain('blacklist');
    }
  });

  test('enforces user deny rules for bare tab ids', () => {
    setHostPolicy({ deniedDomains: ['**.bank.example'] });
    const result = classifyAttachUrl('https://secure.bank.example/accounts');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasonDetail).toContain('BYOB_DENIED_DOMAINS');
  });

  test('allows ordinary web and extension pages', () => {
    expect(classifyAttachUrl('https://example.com/')).toEqual({ ok: true });
    expect(classifyAttachUrl('chrome-extension://abc/options.html')).toEqual({ ok: true });
  });
});
