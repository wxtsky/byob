/**
 * Credential-field detection shared by the snapshot (value redaction) and
 * anything else that might echo form contents back to the model.
 */

/**
 * Field-name patterns whose live `value` must never leave the page.
 *
 * `accessibleName()` falls back to `el.value` when a control has no
 * placeholder or ARIA label, so without this a password, one-time code, or
 * card number the user typed would be shipped to the model as the element's
 * "name". Exported (and interpolated into the in-page script below, so there
 * is exactly one copy) to keep it under test.
 */
export const SENSITIVE_FIELD_RE =
  /pass|pwd|secret|token|otp|2fa|mfa|one-?time|passcode|security-?code|cvv|cvc|\bcc-|card|credit|ssn|social-?security|e-?mail|user-?name|phone|tel|mobile|birth|dob|account/i;

/** Attributes an author would plausibly use to name a credential field. */
const SENSITIVE_PROBE_ATTRS = [
  'name', 'id', 'autocomplete', 'aria-label', 'title', 'placeholder', 'inputmode',
];

/**
 * The redaction predicate, as source text.
 *
 * It lives as a string rather than as a TypeScript function with a mirrored
 * copy inside the script, because only the shipped copy matters: a TS twin
 * would be the thing the tests exercise while the page runs the other one,
 * and the two would drift silently. Tests `new Function` this exact source.
 *
 * Note it must not close over module scope — production builds minify
 * identifiers, so an interpolated `fn.toString()` referencing free variables
 * would break only at runtime. Values are injected by serialization instead.
 */
export const SENSITIVE_PREDICATE_SRC = `function hasSensitiveValue(el) {
  const SENSITIVE_VALUE_RE = ${SENSITIVE_FIELD_RE.toString()};
  const SENSITIVE_PROBE = ${JSON.stringify(SENSITIVE_PROBE_ATTRS)};
  const get = (a) => (el.getAttribute ? el.getAttribute(a) : null);
  const type = (get('type') || '').toLowerCase();
  if (type === 'password' || type === 'email' || type === 'tel') return true;
  if (get('autocomplete') === 'one-time-code') return true;
  for (const a of SENSITIVE_PROBE) {
    const v = get(a);
    if (v && SENSITIVE_VALUE_RE.test(v)) return true;
  }
  return false;
}`;
