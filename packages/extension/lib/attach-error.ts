/**
 * Single source of truth for mapping `tryAttachToTab` failure reasons to
 * the user-visible error envelope. Was previously duplicated as a local
 * `attachErrorToEnvelope` function in 12+ handlers; that drift hid a
 * real bug — when `AttachResult.reason` gained `'flatten_unsupported'`
 * (cdp.ts) every handler still fell through to the "Close DevTools (F12)
 * and retry" hint, which is misleading on Chrome <78 / embedded forks
 * that genuinely lack flatten auto-attach.
 */
import type { AttachResult } from './cdp.js';

export interface AttachErrorEnvelope {
  error: string;
  message: string;
  hint?: string;
}

export function attachErrorEnvelope(reason: AttachResult['reason']): AttachErrorEnvelope {
  if (reason === 'special_page') {
    return {
      error: 'url_forbidden',
      message: 'Tab is on a special page (chrome://, devtools://, etc.) — CDP cannot attach.',
      hint: 'Switch to a regular http(s):// tab.',
    };
  }
  if (reason === 'tab_gone') {
    return { error: 'tab_closed', message: 'Tab was closed.' };
  }
  if (reason === 'flatten_unsupported') {
    return {
      error: 'cdp_attach_failed',
      message: 'CDP flatten auto-attach is not supported on this Chrome build.',
      hint: 'Chrome ≥78 is required; update Chrome or switch from an embedded/forked browser.',
    };
  }
  return {
    error: 'cdp_attach_failed',
    message: 'Could not attach Chrome debugger after 3 retries.',
    hint: 'Close DevTools (F12) on the target tab and retry.',
  };
}
