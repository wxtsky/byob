import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { computeExtensionId } from './extension-id.js';
import { BYOB_DIR, LAUNCHER_PATH, BRIDGES_DIR } from './paths.js';

const NATIVE_HOST_NAME = 'ai.byob.bridge';
const PEM_PATH = path.join(BYOB_DIR, 'extension-key.pem');

interface BrowserEntry {
  name: string;
  manifestDir: string;
  installed: () => boolean;
}

function browserEntries(): BrowserEntry[] {
  const home = os.homedir();
  switch (process.platform) {
    case 'darwin':
      return [
        {
          name: 'Chrome',
          manifestDir: path.join(home, 'Library/Application Support/Google/Chrome/NativeMessagingHosts'),
          installed: () => fs.existsSync('/Applications/Google Chrome.app'),
        },
        {
          name: 'Brave',
          manifestDir: path.join(home, 'Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts'),
          installed: () => fs.existsSync('/Applications/Brave Browser.app'),
        },
        {
          name: 'Edge',
          manifestDir: path.join(home, 'Library/Application Support/Microsoft Edge/NativeMessagingHosts'),
          installed: () => fs.existsSync('/Applications/Microsoft Edge.app'),
        },
      ];
    case 'linux':
      return [
        {
          name: 'Chrome',
          manifestDir: path.join(home, '.config/google-chrome/NativeMessagingHosts'),
          installed: () => true,
        },
        {
          name: 'Brave',
          manifestDir: path.join(home, '.config/BraveSoftware/Brave-Browser/NativeMessagingHosts'),
          installed: () => true,
        },
      ];
    default:
      throw new Error(`Unsupported platform: ${process.platform}`);
  }
}

interface InstallOptions {
  dev?: boolean;
  skipBuild?: boolean;
  repoRoot: string;
}

/** Generate ~/.byob/extension-key.pem if it does not exist. Returns base64 DER public key. */
function ensureExtensionKey(): string {
  if (!fs.existsSync(PEM_PATH)) {
    console.log(`Generating extension key → ${PEM_PATH}`);
    fs.mkdirSync(path.dirname(PEM_PATH), { recursive: true, mode: 0o700 });
    execSync(`openssl genrsa -out "${PEM_PATH}" 2048`, { stdio: 'pipe' });
    fs.chmodSync(PEM_PATH, 0o600);
    console.log('  ✓ generated (mode 0600)');
  }
  return execSync(
    `openssl rsa -in "${PEM_PATH}" -pubout -outform DER | base64 | tr -d '\\n'`,
    { encoding: 'utf-8' },
  ).trim();
}

/**
 * macOS-only quality-of-life helpers. On other platforms these are silent
 * no-ops so the install summary stays uncluttered.
 */
const IS_MAC = process.platform === 'darwin';

/** Open chrome://extensions in the default Chrome (macOS). Best-effort: any
 *  failure is swallowed — the user can always navigate manually. */
function openChromeExtensionsPage(): boolean {
  if (!IS_MAC) return false;
  try {
    const r = spawnSync('open', ['-a', 'Google Chrome', 'chrome://extensions'], { stdio: 'ignore' });
    return r.status === 0;
  } catch {
    return false;
  }
}

/** Pipe `text` into `pbcopy`. Returns true on success. macOS-only. */
function copyToClipboard(text: string): boolean {
  if (!IS_MAC) return false;
  try {
    const r = spawnSync('pbcopy', [], { input: text, stdio: ['pipe', 'ignore', 'ignore'] });
    return r.status === 0;
  } catch {
    return false;
  }
}

/** Is the `claude` CLI on PATH? */
function isClaudeCliInstalled(): boolean {
  try {
    const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

/** Build the extension via WXT — wxt.config.ts will read the same .pem we just wrote. */
function buildExtension(repoRoot: string): string {
  const extDir = path.join(repoRoot, 'packages/extension');
  if (!fs.existsSync(path.join(extDir, 'package.json'))) {
    throw new Error(
      `extension package not found at ${extDir}.\n` +
        'Are you running `byob install` from inside the byob repo?',
    );
  }
  console.log('Building extension (WXT)...');
  execSync('bun run build', { cwd: extDir, stdio: 'inherit' });
  const outDir = path.join(extDir, '.output/chrome-mv3');
  if (!fs.existsSync(outDir)) {
    throw new Error(`extension build did not produce ${outDir}`);
  }
  return outDir;
}

export function install(opts: InstallOptions): void {
  process.umask(0o077);

  // 1. dirs
  fs.mkdirSync(BYOB_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(BRIDGES_DIR, { recursive: true, mode: 0o700 });

  // 2. key (generated once, reused forever)
  const publicKeyB64 = ensureExtensionKey();
  const extensionId = computeExtensionId(publicKeyB64);

  // 3. extension build (uses the key just generated; skip with --skip-build
  //    e.g. when re-running install after a manual build)
  let extOutputDir: string | null = null;
  if (!opts.skipBuild) extOutputDir = buildExtension(opts.repoRoot);

  // 4. launcher script
  const nodeBin = process.execPath;
  const nodeDir = path.dirname(nodeBin);
  const bridgeEntryAbs = path.join(opts.repoRoot, 'packages/bridge/bin/byob-bridge.ts');
  const tsxBinAbs = path.join(opts.repoRoot, 'packages/bridge/node_modules/.bin/tsx');
  const launcherBody = opts.dev
    ? `#!/bin/sh
export PATH="${nodeDir}:$PATH"
exec "${tsxBinAbs}" "${bridgeEntryAbs}" "$@"
`
    : `#!/bin/sh
export PATH="${nodeDir}:$PATH"
exec "${nodeBin}" "${bridgeEntryAbs}" "$@"
`;
  fs.writeFileSync(LAUNCHER_PATH, launcherBody, { mode: 0o755 });

  // 5. NM manifests per browser
  const manifest = {
    name: NATIVE_HOST_NAME,
    description: 'byob local bridge for AI agents',
    path: LAUNCHER_PATH,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };

  const written: string[] = [];
  for (const b of browserEntries()) {
    if (!b.installed()) continue;
    fs.mkdirSync(b.manifestDir, { recursive: true });
    const manifestPath = path.join(b.manifestDir, `${NATIVE_HOST_NAME}.json`);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    written.push(b.name);
  }

  // 6. user-facing summary + next-steps
  const tsxBin = path.join(opts.repoRoot, 'packages/mcp-server/node_modules/.bin/tsx');
  const mcpEntry = path.join(opts.repoRoot, 'packages/mcp-server/bin/byob-mcp.ts');
  const mcpAddCmd = `claude mcp add byob -s user -- ${tsxBin} ${mcpEntry}`;

  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  byob install — done');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Key:        ${PEM_PATH}`);
  console.log(`  Extension:  ${extensionId}`);
  console.log(`  Launcher:   ${LAUNCHER_PATH}`);
  console.log(`  NM manifests written: ${written.length === 0 ? '(none — no supported browser detected)' : written.join(', ')}`);
  if (extOutputDir) console.log(`  Built ext:  ${extOutputDir}`);
  console.log('');

  // macOS QoL: try to open chrome://extensions for the user
  const chromeOpened = openChromeExtensionsPage();

  console.log('Next steps:');
  if (chromeOpened) {
    console.log('  1. Chrome should be opening chrome://extensions for you now.');
    console.log('     Enable "Developer mode" → "Load unpacked"');
  } else {
    console.log('  1. Open chrome://extensions → enable Developer mode → "Load unpacked"');
  }
  if (extOutputDir) console.log(`     → select ${extOutputDir}`);
  console.log('  2. Quit Chrome (⌘Q) and reopen so it reads the new NM manifest');
  console.log('  3. Verify with: byob doctor');
  console.log('');

  // macOS QoL: copy the mcp-add command to the clipboard
  const claudeOnPath = isClaudeCliInstalled();
  const copied = copyToClipboard(mcpAddCmd);

  console.log('Connect to Claude Code:');
  console.log(`  ${mcpAddCmd}`);
  console.log('  (add `-e BYOB_ALLOW_EVAL=1` after `-s user` to enable browser_eval)');
  if (copied) {
    console.log('');
    if (claudeOnPath) {
      console.log('  ✓ Command copied to clipboard — paste it into your terminal (⌘V) and hit Enter.');
    } else {
      console.log('  ✓ Command copied to clipboard.');
      console.log('  ⚠ `claude` CLI not found on PATH — install Claude Code first:');
      console.log('     https://docs.claude.com/en/docs/claude-code/quickstart');
      console.log('     then paste the copied command (⌘V) to register byob.');
    }
  } else if (!claudeOnPath && IS_MAC) {
    console.log('');
    console.log('  ⚠ `claude` CLI not found on PATH — install Claude Code first:');
    console.log('     https://docs.claude.com/en/docs/claude-code/quickstart');
  }
  console.log('');
}
