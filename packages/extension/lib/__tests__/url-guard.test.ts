import { test, expect, beforeEach, afterEach, describe } from 'bun:test';
import {
  checkUrlAllowed,
  coerceDomainList,
  setAllowedFlags,
  getAllowedFlags,
  setHostPolicy,
  getHostPolicy,
  hostMatchesPattern,
  normalizeHost,
  isSpecialUrl,
  FLAG_KEYS,
  HOST_POLICY_KEYS,
} from '../url-guard.js';

function resetGuardState(): void {
  setAllowedFlags({ BYOB_ALLOW_FILE: false, BYOB_ALLOW_AUTH_DOMAINS: false });
  setHostPolicy({ allowedDomains: [], deniedDomains: [] });
}

// url-guard keeps its policy in module-level state and bun shares modules
// across test files, so every mutable knob has to be reset on both sides.
// `afterEach` is the load-bearing one: without it the last case in this file
// leaves a policy behind that silently fails unrelated suites (cdp.ts now
// consults the host policy on every attach).
beforeEach(resetGuardState);
afterEach(resetGuardState);

test('https URL is always allowed', () => {
  expect(checkUrlAllowed('https://example.com/foo')).toEqual({ ok: true });
});

test('chrome:// is forbidden by default', () => {
  const r = checkUrlAllowed('chrome://settings');
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toContain('chrome:');
});

test('chrome-extension:// is allowed (byob inspects extension pages)', () => {
  expect(checkUrlAllowed('chrome-extension://abc/popup.html')).toEqual({ ok: true });
});

test('file:// is forbidden by default', () => {
  const r = checkUrlAllowed('file:///etc/hosts');
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toContain('file:');
});

test('file:// is allowed when BYOB_ALLOW_FILE flag is set', () => {
  setAllowedFlags({ BYOB_ALLOW_FILE: true });
  expect(checkUrlAllowed('file:///tmp/local.html')).toEqual({ ok: true });
});

test('auth-domain blacklist blocks accounts.google.com by default', () => {
  const r = checkUrlAllowed('https://accounts.google.com/signin');
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toContain('blacklist');
});

test('auth-domain blacklist bypassed when BYOB_ALLOW_AUTH_DOMAINS flag is set', () => {
  setAllowedFlags({ BYOB_ALLOW_AUTH_DOMAINS: true });
  expect(checkUrlAllowed('https://accounts.google.com/signin')).toEqual({ ok: true });
});

test('flags are partial-merge: setting one preserves the other', () => {
  setAllowedFlags({ BYOB_ALLOW_FILE: true });
  setAllowedFlags({ BYOB_ALLOW_AUTH_DOMAINS: true });
  expect(getAllowedFlags()).toEqual({
    BYOB_ALLOW_FILE: true,
    BYOB_ALLOW_AUTH_DOMAINS: true,
  });
});

test('invalid URL is rejected with an explanatory reason', () => {
  const r = checkUrlAllowed('not a url');
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toContain('invalid URL');
});

test('isSpecialUrl matches forbidden protocols', () => {
  expect(isSpecialUrl('chrome://x')).toBe(true);
  expect(isSpecialUrl('https://example.com')).toBe(false);
  expect(isSpecialUrl('not a url')).toBe(false);
});

test('FLAG_KEYS lists every flag known to the cache', () => {
  // If a new flag is added to the Flags type, this test reminds us to extend
  // FLAG_KEYS so background.ts hydrates it from storage.
  expect(FLAG_KEYS.length).toBe(Object.keys(getAllowedFlags()).length);
});

test('HOST_POLICY_KEYS lists every host-policy list known to the cache', () => {
  expect(HOST_POLICY_KEYS.length).toBe(Object.keys(getHostPolicy()).length);
});

describe('normalizeHost', () => {
  test('lowercases and drops the trailing root dot', () => {
    expect(normalizeHost('EXAMPLE.com.')).toBe('example.com');
  });

  test('strips a port but keeps bare IPv6 literals intact', () => {
    expect(normalizeHost('example.com:8443')).toBe('example.com');
    expect(normalizeHost('::1')).toBe('::1');
    expect(normalizeHost('[::1]:8080')).toBe('::1');
  });
});

describe('hostMatchesPattern', () => {
  test('matches exact hosts only', () => {
    expect(hostMatchesPattern('example.com', 'example.com')).toBe(true);
    expect(hostMatchesPattern('example.com', 'www.example.com')).toBe(false);
  });

  test('treats **. as apex plus every subdomain', () => {
    expect(hostMatchesPattern('**.example.com', 'example.com')).toBe(true);
    expect(hostMatchesPattern('**.example.com', 'a.b.example.com')).toBe(true);
    expect(hostMatchesPattern('**.example.com', 'notexample.com')).toBe(false);
    expect(hostMatchesPattern('**.example.com', 'example.com.evil.net')).toBe(false);
  });

  test('treats *. as subdomains only', () => {
    expect(hostMatchesPattern('*.example.com', 'www.example.com')).toBe(true);
    expect(hostMatchesPattern('*.example.com', 'example.com')).toBe(false);
  });

  test('supports a bare wildcard and rejects empty patterns', () => {
    expect(hostMatchesPattern('*', 'anything.test')).toBe(true);
    expect(hostMatchesPattern('', 'example.com')).toBe(false);
  });

  test('does not let dots in a pattern act as regex wildcards', () => {
    expect(hostMatchesPattern('a.example.com', 'axexample.com')).toBe(false);
  });
});

describe('coerceDomainList', () => {
  test('keeps only non-empty trimmed strings', () => {
    expect(coerceDomainList(['a.com', '', '  b.com  ', 3, null])).toEqual(['a.com', 'b.com']);
  });

  test('refuses non-arrays rather than failing open', () => {
    expect(coerceDomainList('a.com')).toEqual([]);
    expect(coerceDomainList(undefined)).toEqual([]);
  });
});

describe('host policy', () => {
  test('denies hosts on the deny list', () => {
    setHostPolicy({ deniedDomains: ['**.chase.com'] });
    expect(checkUrlAllowed('https://secure.chase.com/login').ok).toBe(false);
    expect(checkUrlAllowed('https://example.com/').ok).toBe(true);
  });

  test('switches to allowlist-only when an allow list is set', () => {
    setHostPolicy({ allowedDomains: ['**.github.com'] });
    expect(checkUrlAllowed('https://api.github.com/x').ok).toBe(true);
    expect(checkUrlAllowed('https://example.com/').ok).toBe(false);
  });

  test('lets deny win over allow', () => {
    setHostPolicy({ allowedDomains: ['**.github.com'], deniedDomains: ['gist.github.com'] });
    expect(checkUrlAllowed('https://gist.github.com/x').ok).toBe(false);
  });

  test('normalizes the URL host before matching', () => {
    setHostPolicy({ deniedDomains: ['example.com'] });
    expect(checkUrlAllowed('https://EXAMPLE.com:8443/').ok).toBe(false);
  });

  test('leaves hostless schemes to the protocol rules', () => {
    // Regression: an allowlist must not silently revoke the file:// opt-in.
    setAllowedFlags({ BYOB_ALLOW_FILE: true });
    setHostPolicy({ allowedDomains: ['**.github.com'] });
    expect(checkUrlAllowed('file:///tmp/local.html')).toEqual({ ok: true });
  });

  test('cannot re-enable a forbidden protocol', () => {
    setHostPolicy({ allowedDomains: ['*'] });
    expect(checkUrlAllowed('chrome://settings').ok).toBe(false);
  });

  test('partial-merges like the flag cache does', () => {
    setHostPolicy({ deniedDomains: ['a.com'] });
    setHostPolicy({ allowedDomains: ['b.com'] });
    expect(getHostPolicy()).toEqual({ allowedDomains: ['b.com'], deniedDomains: ['a.com'] });
  });
});
