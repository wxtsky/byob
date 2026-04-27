// Single source of truth for "URLs we never operate on" — both the URL guard
// (read/navigate input check) and CDP attach pre-check (active-tab check)
// import these. Keep this list aligned with what chrome.debugger actually
// rejects, plus the obvious unsafe schemes we choose to deny.
//
// `chrome-extension:` is intentionally NOT here. byob itself is an extension,
// and chrome.debugger.attach() works on extension pages just fine. Wallet /
// tooling extensions (Rabby, MetaMask, translation tools, etc.) are common
// inspection targets, so we allow them by default.
export const FORBIDDEN_PROTOCOLS = [
  'chrome:',
  'chrome-untrusted:',
  'chrome-search:',
  'about:',
  'devtools:',
  'view-source:',
  'file:',
  'edge:',
  'brave:',
];

export function isSpecialUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return FORBIDDEN_PROTOCOLS.includes(u.protocol);
  } catch {
    return false;
  }
}

const DEFAULT_FORBIDDEN_HOSTS = [
  'accounts.google.com',
  'login.microsoftonline.com',
  'appleid.apple.com',
];

/**
 * Extension cannot read process.env directly. We expose env-style toggles via
 * chrome.storage.session keys mirrored from the bridge launcher (Phase 5+ wires
 * the mirror; for now defaults to "all on" — i.e. nothing extra allowed).
 */
function envFlag(_name: string): boolean {
  return false;
}

export function checkUrlAllowed(url: string): { ok: true } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: `invalid URL: ${url}` };
  }

  if (FORBIDDEN_PROTOCOLS.includes(parsed.protocol)) {
    if (parsed.protocol === 'file:' && envFlag('BYOB_ALLOW_FILE')) {
      // allowed by opt-in
    } else {
      return { ok: false, reason: `protocol ${parsed.protocol} is forbidden` };
    }
  }
  if (DEFAULT_FORBIDDEN_HOSTS.includes(parsed.hostname) && !envFlag('BYOB_ALLOW_AUTH_DOMAINS')) {
    return { ok: false, reason: `host ${parsed.hostname} is on the byob blacklist` };
  }
  return { ok: true };
}


export function urlForbiddenError(reason: string): {
  error: 'url_forbidden';
  message: string;
  hint: string;
} {
  return {
    error: 'url_forbidden',
    message: reason,
    hint: 'Set BYOB_ALLOW_FILE=1 (file://) or BYOB_ALLOW_AUTH_DOMAINS=1 (auth domains) to bypass.',
  };
}
