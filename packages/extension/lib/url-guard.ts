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

// ---------------------------------------------------------------------------
// User-configurable host policy
//
// byob drives the browser the user is actually logged into, so "which sites
// may this touch at all" is the security boundary that matters most. A fixed
// three-host blacklist can't express "never my bank" or "only these two
// sites for this session", so both lists are user-supplied and support glob
// patterns:
//
//   example.com        exact host
//   *.example.com      any single-or-multi-label subdomain, NOT the apex
//   **.example.com     the apex and every subdomain
//   *                  everything
//
// Deny always wins. A non-empty allowlist flips the guard into
// allowlist-only mode: anything unmatched is refused.
//
//   chrome.storage.local.set({ BYOB_DENIED_DOMAINS: ['**.chase.com'] })
//   chrome.storage.local.set({ BYOB_ALLOWED_DOMAINS: ['**.github.com'] })
// ---------------------------------------------------------------------------

export type HostPolicy = {
  allowedDomains: string[];
  deniedDomains: string[];
};

export const HOST_POLICY_KEYS: readonly ('BYOB_ALLOWED_DOMAINS' | 'BYOB_DENIED_DOMAINS')[] = [
  'BYOB_ALLOWED_DOMAINS',
  'BYOB_DENIED_DOMAINS',
];

let hostPolicy: HostPolicy = { allowedDomains: [], deniedDomains: [] };

export function setHostPolicy(policy: Partial<HostPolicy>): void {
  hostPolicy = {
    allowedDomains: policy.allowedDomains ?? hostPolicy.allowedDomains,
    deniedDomains: policy.deniedDomains ?? hostPolicy.deniedDomains,
  };
}

export function getHostPolicy(): HostPolicy {
  return hostPolicy;
}

/** Accept only string arrays from storage — a malformed value must not turn
 *  into an accidental allow-everything. */
export function coerceDomainList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

/** Lowercase, strip a trailing root dot, strip the port, unwrap IPv6 brackets. */
export function normalizeHost(host: string): string {
  const t = host.trim();
  if (t.startsWith('[')) {
    const end = t.indexOf(']');
    if (end !== -1) return t.slice(1, end).toLowerCase().replace(/\.+$/, '');
  }
  // Exactly one colon means host:port; more means a bare IPv6 literal.
  const bare = (t.match(/:/g) ?? []).length === 1 ? (t.split(':')[0] ?? '') : t;
  return bare.toLowerCase().replace(/\.+$/, '');
}

/**
 * Match a host against one policy pattern.
 *
 * Deliberately a fixed set of four shapes rather than a glob→RegExp engine.
 * A general matcher would also accept forms the documentation never promises
 * (`ex*ple.com`, `evil*`), and on a security boundary a matcher that is wider
 * than its spec is a liability, not a feature. It also avoids compiling a
 * RegExp per pattern per call — this runs on every CDP attach.
 */
export function hostMatchesPattern(pattern: string, host: string): boolean {
  const h = normalizeHost(host);
  const p = pattern.trim().toLowerCase().replace(/\.+$/, '');
  if (p.length === 0 || h.length === 0) return false;
  if (p === '*') return true;
  // Apex plus every subdomain.
  if (p.startsWith('**.')) {
    const apex = p.slice(3);
    return h === apex || h.endsWith('.' + apex);
  }
  // Subdomains only — the apex itself does not match.
  if (p.startsWith('*.')) return h.endsWith('.' + p.slice(2));
  return h === p;
}

function matchesAny(patterns: string[], host: string): boolean {
  return patterns.some((p) => hostMatchesPattern(p, host));
}

/**
 * Apply only the user-configured host policy to a URL.
 *
 * Split out from `checkUrlAllowed` because the two rule sets belong at
 * different altitudes. `checkUrlAllowed` validates a URL a caller passed in,
 * and only ~20 of byob's 34 handlers have a URL to validate — the rest
 * (click, type, eval, screenshot, get_cookies, …) take a bare `tabId`, so a
 * per-handler guard would leave the policy trivially bypassable. This
 * function is therefore also called from `tryAttachToTab`, the single choke
 * point every CDP-driven tool passes through.
 *
 * Deliberately excludes the protocol list and the built-in auth-host
 * blacklist: those are byob's own heuristics and stay where they are, so
 * enforcing an explicit user policy does not silently change which tabs the
 * existing tools will touch.
 */
export function checkHostPolicy(url: string | undefined): { ok: true } | { ok: false; reason: string } {
  if (!url) return { ok: true };
  try {
    return checkHostPolicyForHost(normalizeHost(new URL(url).hostname));
  } catch {
    return { ok: true };
  }
}

/**
 * Boolean form of the host policy for callers that filter rather than refuse
 * — `browser_list_tabs` hides denied tabs, `browser_get_cookies` drops denied
 * cookies. Accepts a bare host or a cookie-style `.example.com` domain.
 */
export function isHostAllowedByPolicy(hostOrCookieDomain: string): boolean {
  return checkHostPolicyForHost(normalizeHost(hostOrCookieDomain.replace(/^\./, ''))).ok;
}

/** Policy check against an already-parsed, already-normalized host, so
 *  `checkUrlAllowed` doesn't parse the same URL twice. */
function checkHostPolicyForHost(host: string): { ok: true } | { ok: false; reason: string } {
  // Hostless schemes (file:, data:) have nothing to match against.
  if (host.length === 0) return { ok: true };

  if (matchesAny(hostPolicy.deniedDomains, host)) {
    return { ok: false, reason: `host ${host} matches BYOB_DENIED_DOMAINS` };
  }
  if (hostPolicy.allowedDomains.length > 0 && !matchesAny(hostPolicy.allowedDomains, host)) {
    return { ok: false, reason: `host ${host} is not in BYOB_ALLOWED_DOMAINS` };
  }
  return { ok: true };
}

// Feature flags that loosen the URL guard. Exposed via chrome.storage.local
// so the user can opt in from the extension SW console. The background entry
// loads them at startup and listens to storage.onChanged — reads stay sync
// (cache lookup) so url-guard remains a sync function for its callers.
export type Flags = {
  BYOB_ALLOW_FILE: boolean;
  BYOB_ALLOW_AUTH_DOMAINS: boolean;
};

export const FLAG_KEYS: readonly (keyof Flags)[] = [
  'BYOB_ALLOW_FILE',
  'BYOB_ALLOW_AUTH_DOMAINS',
];

let flagsCache: Flags = {
  BYOB_ALLOW_FILE: false,
  BYOB_ALLOW_AUTH_DOMAINS: false,
};

export function setAllowedFlags(flags: Partial<Flags>): void {
  flagsCache = { ...flagsCache, ...flags };
}

export function getAllowedFlags(): Flags {
  return flagsCache;
}

function envFlag(name: keyof Flags): boolean {
  return flagsCache[name];
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
  // Hostless schemes (file:, data:, blob:) fall through the policy check —
  // they have no host to match, and are governed by the protocol list and
  // BYOB_ALLOW_FILE above. Without that, any allowlist would silently revoke
  // the file:// opt-in.
  const host = normalizeHost(parsed.hostname);
  const policy = checkHostPolicyForHost(host);
  if (!policy.ok) return policy;

  if (DEFAULT_FORBIDDEN_HOSTS.includes(host) && !envFlag('BYOB_ALLOW_AUTH_DOMAINS')) {
    return { ok: false, reason: `host ${host} is on the byob blacklist` };
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
    hint:
      "Adjust via the byob SW console: chrome.storage.local.set({ BYOB_ALLOW_FILE: true }) " +
      "for file:// URLs, BYOB_ALLOW_AUTH_DOMAINS for the built-in auth-domain blacklist, or " +
      "BYOB_DENIED_DOMAINS / BYOB_ALLOWED_DOMAINS (arrays of host globs like '**.example.com') " +
      "for the host policy.",
  };
}
