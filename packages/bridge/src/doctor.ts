import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { VERSION } from '@byob/shared';
import { EXTENSION_KEY_PATH, LAUNCHER_PATH } from './paths.js';
import { listAliveBridges } from './bridge-registry.js';
import { computeExtensionId } from './extension-id.js';
import { browserEntries, type BrowserEntry } from './install/browser-entries.js';
import { parseLauncher } from './install/launcher.js';

const IS_WIN = process.platform === 'win32';

function ok(label: string, detail = ''): void {
  console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? '  ' + detail : ''}`);
}
function bad(label: string, detail = ''): void {
  console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? '  ' + detail : ''}`);
}
function warn(label: string, detail = ''): void {
  console.log(`  \x1b[33m!\x1b[0m ${label}${detail ? '  ' + detail : ''}`);
}
function dim(label: string): void {
  console.log(`  \x1b[2m- ${label}\x1b[0m`);
}

/** The extension ID the manifests must allow — derived from the signing key. */
function expectedExtensionId(): string | null {
  try {
    const priv = crypto.createPrivateKey({ key: fs.readFileSync(EXTENSION_KEY_PATH), format: 'pem' });
    const spki = crypto.createPublicKey(priv).export({ type: 'spki', format: 'der' }) as Buffer;
    return computeExtensionId(spki.toString('base64'));
  } catch {
    return null;
  }
}

/**
 * Find the OS-level start time of a running browser main process. Lets the
 * doctor compare "Chrome was launched at X" against "manifest was written
 * at Y" — if X < Y, the user almost certainly hasn't ⌘Q-restarted Chrome
 * since `bun run setup`, which is the #1 cause of `no live bridge`.
 *
 * Skips helpers / renderers (any line with `--type=` or `Helper`). Returns
 * null on Windows (we don't enumerate processes there) or if no main
 * process is found. `entry` is the matching BrowserEntry name.
 */
function browserMainEpoch(): { name: string; entry: string; pid: number; epoch: number } | null {
  if (IS_WIN) return null;
  try {
    // LC_ALL=C: lstart is localised ("四 10月/ 1 17:39:09 2026" under zh_CN),
    // and Date.parse only reads the English form.
    const r = spawnSync('ps', ['-ax', '-o', 'pid=,lstart=,command='], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
    });
    if (r.status !== 0) return null;
    const PATTERNS: Array<{ name: string; entry: string; re: RegExp }> = [
      { name: 'Google Chrome', entry: 'Chrome', re: /\/Google Chrome\.app\/Contents\/MacOS\/Google Chrome(?:\s|$)/ },
      { name: 'Brave Browser', entry: 'Brave', re: /\/Brave Browser\.app\/Contents\/MacOS\/Brave Browser(?:\s|$)/ },
      { name: 'Microsoft Edge', entry: 'Edge', re: /\/Microsoft Edge\.app\/Contents\/MacOS\/Microsoft Edge(?:\s|$)/ },
      { name: 'Chrome', entry: 'Chrome', re: /(?:^|\s)\/(?:opt\/google\/chrome\/|usr\/bin\/)?google-chrome(?:-stable)?(?:\s|$)/ },
      { name: 'Chrome', entry: 'Chrome', re: /\/opt\/google\/chrome\/chrome(?:\s|$)/ },
      { name: 'Brave', entry: 'Brave', re: /\/opt\/brave\.com\/brave\/brave(?:\s|$)/ },
      { name: 'Edge', entry: 'Edge', re: /\/opt\/microsoft\/msedge\/msedge(?:\s|$)/ },
      { name: 'Chromium', entry: 'Chromium', re: /\/chromium(?:-browser)?\/chromium(?:-browser)?(?:\s|$)/ },
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
      if (Number.isFinite(epoch)) return { name: hit.name, entry: hit.entry, pid, epoch };
    }
    return null;
  } catch {
    return null;
  }
}

function manifestMtime(entryName: string): number | null {
  // Windows manifests live in ~/.byob/ and we don't read process start times there.
  if (IS_WIN) return null;
  const entry = browserEntries().find((b) => b.name === entryName);
  if (!entry) return null;
  try {
    return fs.statSync(entry.manifestPath).mtimeMs;
  } catch {
    return null;
  }
}

/** Print actionable hints under the `✗ no live bridge` line. */
function printNoLiveBridgeHints(extensionId: string | null, extensionDir: string): void {
  const Y = '\x1b[33m';
  const D = '\x1b[2m';
  const R = '\x1b[0m';

  const printCommonCauses = (lead: string): void => {
    console.log(`    ${D}↳ ${lead}${R}`);
    console.log(`    ${D}    1. the byob extension is not loaded / disabled in chrome://extensions${R}`);
    console.log(`    ${D}    2. the extension's ID in chrome://extensions is not ${extensionId ?? '(see above)'}${R}`);
    console.log(`    ${D}       fix: remove that copy and load ${extensionDir}${R}`);
    console.log(`    ${D}    3. you loaded the extension into a browser without a manifest (see above)${R}`);
  };

  // Windows: no clean way to read main-process lstart, so skip the timing
  // diagnostic and show the checklist directly.
  if (IS_WIN) {
    printCommonCauses('the byob extension never connected — most likely:');
    return;
  }

  const browser = browserMainEpoch();
  if (browser === null) {
    console.log(`    ${D}↳ no Chrome / Brave / Edge / Chromium main process detected — open your browser first.${R}`);
    return;
  }
  const manifestMs = manifestMtime(browser.entry);
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

/** Check one browser's manifest: present, and pointing at our launcher and extension. */
function checkManifest(b: BrowserEntry, extensionId: string | null): void {
  if (!fs.existsSync(b.manifestPath)) {
    if (b.installed()) bad(b.name, `${b.manifestPath} missing → re-run: bun run setup`);
    else dim(`${b.name}: not installed`);
    return;
  }
  let m: { path?: unknown; allowed_origins?: unknown };
  try {
    m = JSON.parse(fs.readFileSync(b.manifestPath, 'utf8')) as typeof m;
  } catch {
    bad(b.name, `${b.manifestPath} is not valid JSON → re-run: bun run setup`);
    return;
  }
  const problems: string[] = [];
  if (m.path !== LAUNCHER_PATH) problems.push(`runs ${String(m.path)}, not ${LAUNCHER_PATH}`);
  const origin = extensionId ? `chrome-extension://${extensionId}/` : null;
  if (origin && !(Array.isArray(m.allowed_origins) && m.allowed_origins.includes(origin))) {
    problems.push(`allows ${JSON.stringify(m.allowed_origins)}, not ${origin}`);
  }
  if (problems.length) bad(b.name, `${b.manifestPath}: ${problems.join('; ')} → re-run: bun run setup`);
  else ok(b.name, b.manifestPath);

  if (b.regKey) {
    // Windows: Chrome reads the manifest path from this registry key.
    try {
      execSync(`reg query "${b.regKey}" /ve`, { stdio: 'pipe' });
      ok(`${b.name} (registry)`, b.regKey);
    } catch {
      bad(`${b.name} (registry)`, `${b.regKey} missing → re-run: bun run setup`);
    }
  }
}

/** Say whether Chrome gets the installed bundle or the repo source, and that it exists. */
function reportLauncherTarget(body: string): void {
  const { mode, argv } = parseLauncher(body);
  const [program, script] = [argv[0], argv[argv.length - 1]];
  if (mode === 'unknown' || !program || !script) {
    bad('runs', 'unrecognised launcher → re-run: bun run setup');
    return;
  }
  const label = mode === 'bundle' ? 'runs bundle' : 'runs source (tsx, --dev)';
  if (!fs.existsSync(script)) {
    bad(label, `${script} missing → re-run: bun run setup`);
    return;
  }
  const built = new Date(fs.statSync(script).mtimeMs).toISOString().replace('T', ' ').slice(0, 16);
  ok(label, mode === 'bundle' ? `${script}  (built ${built})` : script);
  if (!fs.existsSync(program)) bad('with', `${program} missing → re-run: bun run setup`);
  else ok('with', program);
}

interface BridgeStatus {
  connected?: boolean;
  version?: string;
  extensionVersion?: string | null;
}

/** GET /status over a bridge's socket; null when it doesn't answer. */
function fetchStatus(sock: string): Promise<BridgeStatus | null> {
  return new Promise((resolve) => {
    const req = http.get({ socketPath: sock, path: '/status', timeout: 1500 }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(buf) as BridgeStatus);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

export async function doctor(opts: { repoRoot?: string } = {}): Promise<void> {
  const extensionDir = opts.repoRoot
    ? path.join(opts.repoRoot, 'packages/extension/output/chrome-mv3')
    : 'packages/extension/output/chrome-mv3 in your byob checkout';

  console.log('Extension:');
  const extensionId = expectedExtensionId();
  if (extensionId) ok(`ID ${extensionId}`, '— chrome://extensions must show this ID');
  else bad(`no signing key at ${EXTENSION_KEY_PATH}`, '→ run: bun run setup');

  console.log('\nNative Messaging manifest:');
  let entries: BrowserEntry[] = [];
  try {
    entries = browserEntries();
  } catch {
    dim(`platform ${process.platform} not yet enumerated by doctor`);
  }
  for (const b of entries) checkManifest(b, extensionId);

  console.log('\nLauncher:');
  if (fs.existsSync(LAUNCHER_PATH)) {
    ok(LAUNCHER_PATH);
    reportLauncherTarget(fs.readFileSync(LAUNCHER_PATH, 'utf8'));
  } else bad(LAUNCHER_PATH, 'missing → run: bun run setup');

  console.log('\nBridge process:');
  const alive = listAliveBridges();
  if (alive.length === 0) {
    bad('no live bridge');
    printNoLiveBridgeHints(extensionId, extensionDir);
    return;
  }
  for (const b of alive) {
    const upS = Math.round((Date.now() - b.startedAt) / 1000);
    ok(`pid ${b.pid}, deviceId ${b.deviceId}`, `uptime ${upS}s`);
  }

  console.log('\nIPC socket:');
  for (const b of alive) {
    const status = await fetchStatus(b.socket);
    if (!status) {
      bad(b.socket, 'not reachable');
      continue;
    }
    ok(b.socket, `bridge v${status.version ?? '?'}, extension v${status.extensionVersion ?? '?'}`);
    if (status.version !== VERSION) {
      warn(`bridge is v${status.version ?? '(older than 0.7)'}, this checkout is v${VERSION}`, '→ re-run: bun run setup, then reload the extension');
    }
    if (status.extensionVersion !== VERSION) {
      warn(
        `extension is v${status.extensionVersion ?? '(older build)'}, this checkout is v${VERSION}`,
        `→ reload it in chrome://extensions (folder: ${extensionDir})`,
      );
    }
  }
}
