import * as path from 'node:path';
import * as os from 'node:os';

export const DOKO_DIR        = path.join(os.homedir(), '.byob');
export const REGISTRY_PATH   = path.join(DOKO_DIR, 'bridges.json');
export const BRIDGES_DIR     = path.join(DOKO_DIR, 'bridges');
export const LAUNCHER_PATH   = path.join(DOKO_DIR, 'bridge-host.sh');
export const LOG_PATH        = path.join(DOKO_DIR, 'bridge.log');
export const EVAL_AUDIT_PATH = path.join(DOKO_DIR, 'eval-audit.log');
export const SCREENSHOTS_DIR = path.join(DOKO_DIR, 'screenshots');

export function socketPathFor(deviceId: string): string {
  return path.join(BRIDGES_DIR, `${deviceId}.sock`);
}
