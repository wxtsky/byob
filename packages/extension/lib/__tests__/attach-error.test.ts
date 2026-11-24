import { describe, expect, test } from 'bun:test';
import { attachErrorEnvelope } from '../attach-error.js';

describe('attachErrorEnvelope', () => {
  test('surfaces which host policy rule refused the attach', () => {
    const env = attachErrorEnvelope({
      reason: 'host_forbidden',
      reasonDetail: 'host secure.chase.com matches BYOB_DENIED_DOMAINS',
    });
    expect(env.error).toBe('url_forbidden');
    expect(env.message).toContain('secure.chase.com');
    expect(env.hint).toContain("only they can change it");
  });

  test('falls back to generic copy when host_forbidden carries no detail', () => {
    const env = attachErrorEnvelope({ reason: 'host_forbidden' });
    expect(env.error).toBe('url_forbidden');
    expect(env.message).toContain('host policy');
  });

  test('tailors special_page and tab_gone wording when given an operation', () => {
    expect(attachErrorEnvelope({ reason: 'special_page', reasonDetail: 'protocol chrome: is forbidden' }, { what: 'screenshot' }).message).toBe(
      'Cannot screenshot: protocol chrome: is forbidden.',
    );
    expect(attachErrorEnvelope({ reason: 'tab_gone' }, { what: 'recording' }).message).toBe(
      'Tab was closed before recording could attach.',
    );
  });

  test('uses generic wording when no operation is given', () => {
    expect(attachErrorEnvelope({ reason: 'special_page' }).message).toContain('Chrome refused the debugger');
    expect(attachErrorEnvelope({ reason: 'tab_gone' }).message).toBe('Tab was closed.');
  });

  test('points at the launch flag for other extensions\' pages, at the user for chrome://', () => {
    const ext = attachErrorEnvelope({ reason: 'special_page', reasonDetail: 'Chrome refused the debugger on chrome-extension://abc/ask.html' });
    expect(ext.error).toBe('cdp_attach_failed');
    expect(ext.hint).toContain('--extensions-on-chrome-urls');
    const ui = attachErrorEnvelope({ reason: 'special_page', reasonDetail: 'Chrome refused the debugger on chrome://extensions/' });
    expect(ui.hint).toContain('never');
  });

  test('keeps flatten_unsupported distinct from a plain attach failure', () => {
    // Regression: this reason used to fall through to the "close DevTools"
    // hint, which is wrong on Chrome <78 / embedded forks.
    const flatten = attachErrorEnvelope({ reason: 'flatten_unsupported' });
    expect(flatten.error).toBe('cdp_attach_failed');
    expect(flatten.hint).toContain('Chrome ≥78');

    const generic = attachErrorEnvelope({ reason: 'attach_failed' });
    expect(generic.error).toBe('cdp_attach_failed');
    expect(generic.hint).toContain('DevTools');
  });
});
