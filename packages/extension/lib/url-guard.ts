const FORBIDDEN_PROTOCOLS = [
  'chrome:',
  'chrome-extension:',
  'about:',
  'devtools:',
  'view-source:',
  'file:',
];

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
