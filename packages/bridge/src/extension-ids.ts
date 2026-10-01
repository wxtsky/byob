/**
 * Extension IDs besides the one derived from the local signing key that may
 * talk to the bridge — e.g. a Chrome Web Store build, whose ID is fixed by
 * the store, or a teammate's differently keyed build. Added with
 * `byob install --extension-id <id>` and kept in ~/.byob/extension-ids.json so
 * re-running setup doesn't drop them.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXTRA_EXTENSION_IDS_PATH } from './paths.js';

/** Chrome extension IDs are 32 letters a–p. */
export function isExtensionId(s: string): boolean {
  return /^[a-p]{32}$/.test(s);
}

export function readExtraExtensionIds(file = EXTRA_EXTENSION_IDS_PATH): string[] {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && isExtensionId(x)) : [];
  } catch {
    return [];
  }
}

/** Remember more IDs; throws on anything that isn't an extension ID. Returns the full list. */
export function addExtraExtensionIds(ids: string[], file = EXTRA_EXTENSION_IDS_PATH): string[] {
  const bad = ids.filter((id) => !isExtensionId(id));
  if (bad.length) throw new Error(`not a Chrome extension ID (32 letters a–p): ${bad.join(', ')}`);
  const all = [...new Set([...readExtraExtensionIds(file), ...ids])];
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  return all;
}

/** `allowed_origins` for the Native Messaging manifest. */
export function allowedOrigins(selfId: string, extra: string[]): string[] {
  return [...new Set([selfId, ...extra])].map((id) => `chrome-extension://${id}/`);
}
