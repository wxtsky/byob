import { defineConfig } from 'wxt';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

// ─────────────────────────────────────────────────────────────────────────
// Per-user extension key.
//
// Each install gets its own RSA keypair under ~/.byob/extension-key.pem,
// generated on first `byob install`. The public-key DER (base64) lives in
// manifest.key — Chrome derives the extension ID from this, so two byob
// users on different machines get two different IDs (and two different NM
// manifest allowed_origins). No key collision, no central authority.
//
// If the key file does not yet exist (e.g. user is running `wxt build`
// before `byob install`), we fall back to a clearly-stub key so the build
// still succeeds with a warning. The Chrome extension ID derived from the
// stub will not match anything the bridge manifest allows, which is the
// correct failure mode.
// ─────────────────────────────────────────────────────────────────────────
const PEM_PATH = path.join(os.homedir(), '.byob', 'extension-key.pem');

const STUB_KEY =
  'STUB_KEY_RUN_BYOB_INSTALL_FIRST' + 'A'.repeat(360);

function loadPublicKeyB64(): string {
  if (!fs.existsSync(PEM_PATH)) {
    console.warn(`\n[byob/wxt] ⚠️  ${PEM_PATH} not found.`);
    console.warn('[byob/wxt] ⚠️  Run "byob install" first to generate your local key.');
    console.warn('[byob/wxt] ⚠️  Building with a stub key — extension ID will NOT match the NM manifest.\n');
    return STUB_KEY;
  }
  try {
    // Pure node — works on macOS, Linux, and Windows (no openssl dep).
    const priv = crypto.createPrivateKey({
      key: fs.readFileSync(PEM_PATH),
      format: 'pem',
    });
    const pub = crypto.createPublicKey(priv);
    const spkiDer = pub.export({ type: 'spki', format: 'der' }) as Buffer;
    return spkiDer.toString('base64');
  } catch (e) {
    console.error('[byob/wxt] failed to read extension key:', e);
    return STUB_KEY;
  }
}

export default defineConfig({
  manifest: {
    name: 'byob — Bring Your Own Browser',
    description: 'Local-only browser bridge for AI agents (MCP)',
    version: '0.2.0',
    key: loadPublicKeyB64(),
    permissions: [
      'debugger',
      'tabs',
      'scripting',
      'cookies',
      'nativeMessaging',
      'storage',
      'alarms',
      'idle',
      'power',
      'notifications',
      'offscreen',
    ],
    host_permissions: ['<all_urls>'],
    minimum_chrome_version: '116',
  },
});
