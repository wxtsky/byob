import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { addExtraExtensionIds, allowedOrigins, isExtensionId, readExtraExtensionIds } from './extension-ids.js';

const A = 'abcdefghijklmnopabcdefghijklmnop';
const B = 'ponmlkjihgfedcbaponmlkjihgfedcba';

describe('extra extension IDs', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'byob-ids-')), 'extension-ids.json');

  it('validates the ID shape', () => {
    expect(isExtensionId(A)).toBe(true);
    expect(isExtensionId('abc')).toBe(false);
    expect(isExtensionId(A.replace('a', 'z'))).toBe(false);
  });

  it('persists, de-duplicates and refuses garbage', () => {
    expect(readExtraExtensionIds(file)).toEqual([]);
    expect(addExtraExtensionIds([A], file)).toEqual([A]);
    expect(addExtraExtensionIds([A, B], file)).toEqual([A, B]);
    expect(() => addExtraExtensionIds(['nope'], file)).toThrow('not a Chrome extension ID');
    expect(readExtraExtensionIds(file)).toEqual([A, B]);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('builds allowed_origins with the local key first', () => {
    expect(allowedOrigins(B, [A, B])).toEqual([`chrome-extension://${B}/`, `chrome-extension://${A}/`]);
  });
});
