import { test, expect, beforeEach } from 'bun:test';
import {
  checkUrlAllowed,
  setAllowedFlags,
  getAllowedFlags,
  isSpecialUrl,
  FLAG_KEYS,
} from '../url-guard.js';

beforeEach(() => {
  // Reset flags between tests so prior cases don't leak.
  setAllowedFlags({ BYOB_ALLOW_FILE: false, BYOB_ALLOW_AUTH_DOMAINS: false });
});

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
