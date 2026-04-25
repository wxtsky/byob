import { test, expect } from 'bun:test';
import { computeExtensionId } from './extension-id.js';

test('maps hex 0-f to a-p across the first 32 chars of SHA-256', () => {
  // DER bytes of a single 0x00 — verified out of band:
  //   echo -n $'\x00' | openssl dgst -sha256 -hex
  //   → 6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d
  // First 32 hex: 6e340b9cffb37a989ca544e6bb780a2c
  // Mapped a..p:  godealjmppldhkjijmkfeeogllhiakcm
  const trivialKeyB64 = Buffer.from([0x00]).toString('base64');
  const id = computeExtensionId(trivialKeyB64);
  expect(id).toHaveLength(32);
  expect(id).toMatch(/^[a-p]{32}$/);
  expect(id).toBe('godealjmppldhkjijmkfeeogllhiakcm');
});

test('output is deterministic and idempotent', () => {
  const k = Buffer.from('hello world', 'utf-8').toString('base64');
  expect(computeExtensionId(k)).toBe(computeExtensionId(k));
});
