/**
 * Single source of truth for mapping `tryAttachToTab` failure reasons to
 * the user-visible error envelope. Was previously duplicated as a local
 * `attachErrorToEnvelope` function in 12+ handlers; that drift hid a
 * real bug — when `AttachResult.reason` gained `'flatten_unsupported'`
 * (cdp.ts) every handler still fell through to the "Close DevTools (F12)
 * and retry" hint, which is misleading on Chrome <78 / embedded forks
 * that genuinely lack flatten auto-attach.
 *
 * Handlers pass the whole `AttachResult` rather than just `.reason` so a
 * new reason can carry detail (see `reasonDetail`) without every call site
 * having to be updated again — the same drift, one level down.
 */
import type { AttachResult } from './cdp.js';

export interface AttachErrorEnvelope {
  error: string;
  message: string;
  hint?: string;
}

/**
 * `what` is a short verb phrase naming the operation ('screenshot',
 * 'record', 'extract_table'). It only tailors the wording; omit it and the
 * generic phrasing is used.
 */
export interface AttachErrorContext {
  what?: string;
}

export function attachErrorEnvelope(
  result: Pick<AttachResult, 'reason' | 'reasonDetail'>,
  ctx: AttachErrorContext = {},
): AttachErrorEnvelope {
  const { reason, reasonDetail } = result;
  const { what } = ctx;

  if (reason === 'host_forbidden') {
    return {
      error: 'url_forbidden',
      message: reasonDetail ?? 'Tab host is blocked by the byob host policy.',
      hint:
        'Adjust in the byob SW console: chrome.storage.local.set({ BYOB_DENIED_DOMAINS: [...] }) ' +
        'or BYOB_ALLOWED_DOMAINS (arrays of host globs like "**.example.com").',
    };
  }
  if (reason === 'special_page') {
    return {
      error: 'url_forbidden',
      message: what
        ? `Cannot ${what} on special pages (chrome://, devtools://, etc.).`
        : 'Tab is on a special page (chrome://, devtools://, etc.) — CDP cannot attach.',
      hint: 'Switch to a regular http(s):// tab.',
    };
  }
  if (reason === 'tab_gone') {
    return {
      error: 'tab_closed',
      message: what ? `Tab was closed before ${what} could attach.` : 'Tab was closed.',
    };
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
    hint: 'Common causes: DevTools (F12) is open on this tab; another extension already holds the debugger.',
  };
}
