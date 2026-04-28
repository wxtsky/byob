import * as path from 'node:path';
import * as os from 'node:os';

export const BYOB_DIR        = path.join(os.homedir(), '.byob');
export const REGISTRY_PATH   = path.join(BYOB_DIR, 'bridges.json');
export const BRIDGES_DIR     = path.join(BYOB_DIR, 'bridges');
// Windows: .cmd batch file (Chrome NM hosts must be executable directly).
// macOS / Linux: POSIX shell script with #!/bin/sh shebang + 0755.
export const LAUNCHER_PATH   = path.join(
  BYOB_DIR,
  process.platform === 'win32' ? 'bridge-host.cmd' : 'bridge-host.sh',
);
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
