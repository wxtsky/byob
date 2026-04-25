import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { BYOB_DIR, LAUNCHER_PATH } from './paths.js';
import { listAliveBridges } from './bridge-registry.js';

const CHROME_MANIFEST_DARWIN = path.join(
  os.homedir(),
  'Library/Application Support/Google/Chrome/NativeMessagingHosts/ai.byob.bridge.json',
);
const CHROME_MANIFEST_LINUX = path.join(
  os.homedir(),
  '.config/google-chrome/NativeMessagingHosts/ai.byob.bridge.json',
);
const CHROME_REG_KEY_WIN =
  'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\ai.byob.bridge';
const CHROME_MANIFEST_WIN = path.join(BYOB_DIR, 'ai.byob.bridge.chrome.json');

function ok(label: string, detail = ''): void {
  console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? '  ' + detail : ''}`);
}
function bad(label: string, detail = ''): void {
  console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? '  ' + detail : ''}`);
}
function dim(label: string): void {
  console.log(`  \x1b[2m- ${label}\x1b[0m`);
}

async function pingSocket(sock: string): Promise<boolean> {
  return new Promise((resolve) => {
    const c = net.createConnection(sock);
    c.setTimeout(1000);
    c.on('connect', () => {
      c.destroy();
      resolve(true);
    });
    c.on('error', () => resolve(false));
    c.on('timeout', () => {
      c.destroy();
      resolve(false);
    });
  });
}

export async function doctor(): Promise<void> {
  console.log('Native Messaging manifest:');
  if (process.platform === 'darwin') {
    if (fs.existsSync(CHROME_MANIFEST_DARWIN)) ok('Chrome', CHROME_MANIFEST_DARWIN);
    else bad('Chrome', `missing → run: byob install`);
  } else if (process.platform === 'linux') {
    if (fs.existsSync(CHROME_MANIFEST_LINUX)) ok('Chrome', CHROME_MANIFEST_LINUX);
    else bad('Chrome', `missing → run: byob install`);
  } else if (process.platform === 'win32') {
    // Windows: Chrome reads the manifest path from a registry key. Verify
    // both the JSON file on disk and that the HKCU key exists.
    if (fs.existsSync(CHROME_MANIFEST_WIN)) ok('Chrome (manifest)', CHROME_MANIFEST_WIN);
    else bad('Chrome (manifest)', `missing → run: byob install`);
    try {
      execSync(`reg query "${CHROME_REG_KEY_WIN}" /ve`, { stdio: 'pipe' });
      ok('Chrome (registry)', CHROME_REG_KEY_WIN);
    } catch {
      bad('Chrome (registry)', `${CHROME_REG_KEY_WIN} missing → run: byob install`);
    }
  } else {
    dim(`platform ${process.platform} not yet enumerated by doctor`);
  }

  console.log('\nLauncher:');
  if (fs.existsSync(LAUNCHER_PATH)) ok(LAUNCHER_PATH);
  else bad(LAUNCHER_PATH, 'missing → run: byob install');

  console.log('\nBridge process:');
  const alive = listAliveBridges();
  if (alive.length === 0) {
    bad('no live bridge', 'open Chrome with the byob extension enabled');
  } else {
    for (const b of alive) {
      const upS = Math.round((Date.now() - b.startedAt) / 1000);
      ok(`pid ${b.pid}, deviceId ${b.deviceId}`, `uptime ${upS}s`);
    }
  }

  console.log('\nIPC socket:');
  if (alive.length === 0) {
    dim('skipped (no live bridge)');
  } else {
    for (const b of alive) {
      const reachable = await pingSocket(b.socket);
      if (reachable) ok(b.socket);
      else bad(b.socket, 'not reachable');
    }
  }
}
