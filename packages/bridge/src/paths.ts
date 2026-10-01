import * as path from 'node:path';
import * as os from 'node:os';

// BYOB_HOME relocates all runtime state (registry, sockets, logs). The e2e
// harness uses it so a test browser never shows up in the user's registry.
export const BYOB_DIR        = process.env.BYOB_HOME || path.join(os.homedir(), '.byob');
export const REGISTRY_PATH   = path.join(BYOB_DIR, 'bridges.json');
export const BRIDGES_DIR     = path.join(BYOB_DIR, 'bridges');
// Windows: .cmd batch file (Chrome NM hosts must be executable directly).
// macOS / Linux: POSIX shell script with #!/bin/sh shebang + 0755.
export const LAUNCHER_PATH   = path.join(
  BYOB_DIR,
  process.platform === 'win32' ? 'bridge-host.cmd' : 'bridge-host.sh',
);
// Default (non-dev) installs run copies of the single-file builds from here,
// not from the repo checkout.
export const BRIDGE_BUNDLE_PATH = path.join(BYOB_DIR, 'bridge', 'byob-bridge.mjs');
export const MCP_BUNDLE_PATH    = path.join(BYOB_DIR, 'mcp', 'byob-mcp.mjs');
// BYOB_KEY_PATH overrides where the extension signing key lives (CI / e2e).
export const EXTENSION_KEY_PATH = process.env.BYOB_KEY_PATH || path.join(BYOB_DIR, 'extension-key.pem');
// More extension IDs allowed to connect (a Web Store build, …); see extension-ids.ts.
export const EXTRA_EXTENSION_IDS_PATH = path.join(BYOB_DIR, 'extension-ids.json');
export const LOG_PATH        = path.join(BYOB_DIR, 'bridge.log');
export const EVAL_AUDIT_PATH = path.join(BYOB_DIR, 'eval-audit.log');
export const SCREENSHOTS_DIR = path.join(BYOB_DIR, 'screenshots');
export const DOWNLOADS_DIR   = path.join(BYOB_DIR, 'downloads');
export const PDFS_DIR        = path.join(BYOB_DIR, 'pdfs');

export function socketPathFor(deviceId: string): string {
  // Windows: bind to a Named Pipe. libuv treats Unix-style file paths as
  // `\\.\pipe\<the path>`, which is illegal because of the drive-letter
  // colon — server.listen() fails with EACCES. Named pipes also sidestep
  // filesystem perms and stale-socket cleanup. Downstream consumers
  // (bridge-registry, undici Agent socketPath, net.createConnection in
  // doctor) all natively accept `\\.\pipe\…` strings.
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\byob-${deviceId}`;
  }
  return path.join(BRIDGES_DIR, `${deviceId}.sock`);
}
