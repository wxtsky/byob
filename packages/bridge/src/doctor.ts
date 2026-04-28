import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { BYOB_DIR, LAUNCHER_PATH } from './paths.js';
import { listAliveBridges } from './bridge-registry.js';

const IS_WIN = process.platform === 'win32';

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

/**
 * Find the OS-level start time of a running browser main process. Lets the
 * doctor compare "Chrome was launched at X" against "manifest was written
 * at Y" — if X < Y, the user almost certainly hasn't ⌘Q-restarted Chrome
 * since `bun run setup`, which is the #1 cause of `no live bridge`.
 *
 * Skips helpers / renderers (any line with `--type=` or `Helper`). Returns
 * null on Windows (we don't enumerate processes there) or if no main
 * process is found.
 */
function browserMainEpoch(): { name: string; pid: number; epoch: number } | null {
  if (IS_WIN) return null;
  try {
    const r = spawnSync('ps', ['-ax', '-o', 'pid=,lstart=,command='], { encoding: 'utf8' });
    if (r.status !== 0) return null;
    const PATTERNS: Array<{ name: string; re: RegExp }> = [
      { name: 'Google Chrome', re: /\/Google Chrome\.app\/Contents\/MacOS\/Google Chrome(?:\s|$)/ },
      { name: 'Brave Browser', re: /\/Brave Browser\.app\/Contents\/MacOS\/Brave Browser(?:\s|$)/ },
      { name: 'Microsoft Edge', re: /\/Microsoft Edge\.app\/Contents\/MacOS\/Microsoft Edge(?:\s|$)/ },
      { name: 'Chrome', re: /(?:^|\s)\/(?:opt\/google\/chrome\/|usr\/bin\/)?google-chrome(?:-stable)?(?:\s|$)/ },
    ];
    for (const raw of r.stdout.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      if (/--type=/.test(line) || /Helper/.test(line)) continue;
      const hit = PATTERNS.find((p) => p.re.test(line));
      if (!hit) continue;
      const m = line.match(/^(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+/);
      if (!m) continue;
      const pid = parseInt(m[1]!, 10);
      const epoch = Date.parse(m[2]!);
      if (Number.isFinite(epoch)) return { name: hit.name, pid, epoch };
    }
    return null;
  } catch {
    return null;
  }
}

function activeManifestMtime(): number | null {
  let p: string | null = null;
  if (process.platform === 'darwin') p = CHROME_MANIFEST_DARWIN;
  else if (process.platform === 'linux') p = CHROME_MANIFEST_LINUX;
  // Windows manifests live in ~/.byob/ — no clean single mtime to compare.
  if (!p || !fs.existsSync(p)) return null;
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

/** Print actionable hints under the `✗ no live bridge` line. */
function printNoLiveBridgeHints(): void {
  const Y = '\x1b[33m';
  const D = '\x1b[2m';
  const R = '\x1b[0m';

  const printCommonCauses = (lead: string): void => {
    console.log(`    ${D}↳ ${lead}${R}`);
    console.log(`    ${D}    1. the byob extension is not loaded / disabled in chrome://extensions${R}`);
    console.log(`    ${D}    2. the loaded extension ID does not match the manifest${R}`);
    console.log(`    ${D}       fix: rm ~/.byob/extension-key.pem && bun run setup${R}`);
    console.log(`    ${D}    3. you loaded the extension into a different browser than the manifest is for${R}`);
  };

  // Windows: no clean way to read main-process lstart, so skip the timing
  // diagnostic and show the checklist directly.
  if (IS_WIN) {
    printCommonCauses('the byob extension never connected — most likely:');
    return;
  }

  const browser = browserMainEpoch();
  const manifestMs = activeManifestMtime();

  if (browser === null) {
    console.log(`    ${D}↳ no Chrome / Brave / Edge main process detected — open your browser first.${R}`);
    return;
  }
  if (manifestMs !== null && browser.epoch < manifestMs) {
    const drift = Math.max(1, Math.round((manifestMs - browser.epoch) / 1000));
    console.log(
      `    ${Y}↳ ${browser.name} (pid ${browser.pid}) was started ${drift}s before the bridge manifest.${R}`,
    );
    console.log(
      `    ${Y}  Quit your browser with ⌘Q and reopen — manifests are read only at startup.${R}`,
    );
    return;
  }
  printCommonCauses(`${browser.name} is running, but the byob extension never connected. Most likely:`);
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
    bad('no live bridge');
    printNoLiveBridgeHints();
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
