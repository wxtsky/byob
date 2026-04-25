import * as crypto from 'node:crypto';

/**
 * Compute the Chrome extension ID from the manifest "key" field
 * (a base64-encoded DER public key).
 *
 * Algorithm: SHA-256(DER) → take first 32 hex chars → map each hex digit
 * 0..f to letters a..p.
 */
export function computeExtensionId(publicKeyBase64: string): string {
  const keyBytes = Buffer.from(publicKeyBase64, 'base64');
  const hex = crypto.createHash('sha256').update(keyBytes).digest('hex');
  return hex
    .slice(0, 32)
    .split('')
    .map((c) => String.fromCharCode('a'.charCodeAt(0) + parseInt(c, 16)))
    .join('');
}
