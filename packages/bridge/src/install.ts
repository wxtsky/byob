import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { execSync, spawnSync } from 'node:child_process';
import { computeExtensionId } from './extension-id.js';
import { BYOB_DIR, LAUNCHER_PATH, BRIDGES_DIR } from './paths.js';

const NATIVE_HOST_NAME = 'ai.byob.bridge';
const PEM_PATH = path.join(BYOB_DIR, 'extension-key.pem');
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

/**
 * A browser to install the Native Messaging host into.
 *
 * - On macOS / Linux Chrome reads the manifest from a per-browser
 *   `NativeMessagingHosts/<host>.json` file. `manifestPath` is that file
 *   and `register()` simply writes it.
 * - On Windows Chrome reads the manifest path from a registry key under
 *   `HKCU\Software\<Vendor>\<Browser>\NativeMessagingHosts\<host>`.
 *   We still need the JSON on disk somewhere — we centralise it under
 *   `~/.byob/<host>.json` rather than once per browser — and `register()`
 *   shells out to `reg add` to point the registry key at it.
 */
interface BrowserEntry {
  name: string;
  manifestPath: string;
  installed: () => boolean;
  /** Persist the manifest so this browser will pick it up. */
  register: (manifestJson: string) => void;
}

function browserEntries(): BrowserEntry[] {
  const home = os.homedir();
  switch (process.platform) {
    case 'darwin':
      return [
        fsBrowserEntry(
          'Chrome',
          path.join(
            home,
            'Library/Application Support/Google/Chrome/NativeMessagingHosts',
            `${NATIVE_HOST_NAME}.json`,
          ),
          () => fs.existsSync('/Applications/Google Chrome.app'),
        ),
        fsBrowserEntry(
          'Brave',
          path.join(
            home,
            'Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts',
            `${NATIVE_HOST_NAME}.json`,
          ),
          () => fs.existsSync('/Applications/Brave Browser.app'),
        ),
        fsBrowserEntry(
          'Edge',
          path.join(
            home,
            'Library/Application Support/Microsoft Edge/NativeMessagingHosts',
            `${NATIVE_HOST_NAME}.json`,
          ),
          () => fs.existsSync('/Applications/Microsoft Edge.app'),
        ),
      ];
    case 'linux':
      return [
        fsBrowserEntry(
          'Chrome',
          path.join(home, '.config/google-chrome/NativeMessagingHosts', `${NATIVE_HOST_NAME}.json`),
          () => true,
        ),
        fsBrowserEntry(
          'Brave',
          path.join(
            home,
            '.config/BraveSoftware/Brave-Browser/NativeMessagingHosts',
            `${NATIVE_HOST_NAME}.json`,
          ),
          () => true,
        ),
      ];
    case 'win32': {
      // One JSON file per browser, all under ~/.byob/, keyed by browser
      // name so they're easy to delete on uninstall.
      const winManifest = (browser: string) =>
        path.join(BYOB_DIR, `${NATIVE_HOST_NAME}.${browser}.json`);
      return [
        winBrowserEntry(
          'Chrome',
          winManifest('chrome'),
          `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
        ),
        winBrowserEntry(
          'Brave',
          winManifest('brave'),
          `HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
        ),
        winBrowserEntry(
          'Edge',
          winManifest('edge'),
          `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
        ),
      ];
    }
    default:
      throw new Error(`Unsupported platform: ${process.platform}`);
  }
}

/** Default macOS / Linux browser entry: just write the manifest JSON file. */
function fsBrowserEntry(
  name: string,
  manifestPath: string,
  installed: () => boolean,
): BrowserEntry {
  return {
    name,
    manifestPath,
    installed,
    register: (manifestJson: string) => {
      fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
      fs.writeFileSync(manifestPath, manifestJson);
    },
  };
}

/**
 * Windows browser entry: write the manifest under ~/.byob/ and point a
 * `HKCU\...\NativeMessagingHosts\<host>` registry key at it. We don't try
 * to detect whether Chrome is actually installed (it can live in a half-
 * dozen places) — writing an unused HKCU key is harmless, so we always
 * register and let the user decide.
 */
function winBrowserEntry(name: string, manifestPath: string, regKey: string): BrowserEntry {
  return {
    name,
    manifestPath,
    installed: () => true,
    register: (manifestJson: string) => {
      fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
      fs.writeFileSync(manifestPath, manifestJson);
      // `reg add` overwrites the (Default) value with /f and creates the
      // key if it doesn't exist. Quotes around manifestPath handle spaces
      // (e.g. `C:\Users\Some User\.byob\...`).
      execSync(
        `reg add "${regKey}" /ve /t REG_SZ /d "${manifestPath}" /f`,
        { stdio: 'pipe' },
      );
    },
  };
}

interface InstallOptions {
  dev?: boolean;
  skipBuild?: boolean;
  repoRoot: string;
}

/**
 * Generate ~/.byob/extension-key.pem if it does not exist. Returns the
 * SPKI-DER public key as base64. Pure node — no openssl on PATH required,
 * which matters on Windows where openssl isn't shipped.
 */
function ensureExtensionKey(): string {
  if (!fs.existsSync(PEM_PATH)) {
    console.log(`Generating extension key → ${PEM_PATH}`);
    fs.mkdirSync(path.dirname(PEM_PATH), { recursive: true, mode: 0o700 });
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    // PKCS#1 PEM is what `openssl genrsa` historically wrote, kept for
    // compatibility with any PEM_PATH from a pre-Windows install.
    const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }) as string;
    fs.writeFileSync(PEM_PATH, pem, { mode: 0o600 });
    if (!IS_WIN) fs.chmodSync(PEM_PATH, 0o600);
    console.log('  ✓ generated (mode 0600)');
  }
  // Re-derive the SPKI-DER public key from the private PEM every install
  // run — works regardless of how the PEM was originally created.
  const priv = crypto.createPrivateKey({
    key: fs.readFileSync(PEM_PATH),
    format: 'pem',
  });
  const pub = crypto.createPublicKey(priv);
  const spkiDer = pub.export({ type: 'spki', format: 'der' }) as Buffer;
  return spkiDer.toString('base64');
}

/**
 * Open chrome://extensions in the user's default Chrome.
 * Best-effort: any failure is swallowed — the user can navigate manually.
 *
 * - macOS: `open -a "Google Chrome" chrome://extensions`
 * - Windows: `cmd /c start "" chrome chrome://extensions` (the empty
 *   "" is the start command's title arg, required when the next arg is
 *   quoted)
 * - Linux: silent no-op (xdg-open + a URL won't reliably open Chrome
 *   specifically, and we don't want to open Firefox by accident).
 */
function openExtensionsPage(): boolean {
  try {
    if (IS_MAC) {
      const r = spawnSync('open', ['-a', 'Google Chrome', 'chrome://extensions'], {
        stdio: 'ignore',
      });
      return r.status === 0;
    }
    if (IS_WIN) {
      // `cmd /c start "" chrome chrome://extensions`
      // The empty "" is the start command's title arg — required when the
      // next arg might look like a quoted path.
      const r = spawnSync('cmd', ['/c', 'start', '', 'chrome', 'chrome://extensions'], {
        stdio: 'ignore',
      });
      return r.status === 0;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Pipe `text` into the system clipboard.
 * - macOS: `pbcopy`
 * - Windows: `clip` (built-in, reads stdin)
 * - Linux: silent no-op (no universal clipboard tool).
 */
function copyToClipboard(text: string): boolean {
  try {
    if (IS_MAC) {
      const r = spawnSync('pbcopy', [], { input: text, stdio: ['pipe', 'ignore', 'ignore'] });
      return r.status === 0;
    }
    if (IS_WIN) {
      const r = spawnSync('clip', [], { input: text, stdio: ['pipe', 'ignore', 'ignore'] });
      return r.status === 0;
    }
    return false;
  } catch {
    return false;
  }
}

/** Is the `claude` CLI on PATH? */
function isClaudeCliInstalled(): boolean {
  try {
    const r = spawnSync(IS_WIN ? 'where' : 'which', ['claude'], {
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

/** Build the per-platform launcher script body. */
function buildLauncherBody(opts: InstallOptions): string {
  const nodeBin = process.execPath;
  const nodeDir = path.dirname(nodeBin);
  const bridgeEntryAbs = path.join(opts.repoRoot, 'packages/bridge/bin/byob-bridge.ts');
  const tsxBinAbs = path.join(
    opts.repoRoot,
    'packages/bridge/node_modules/.bin',
    IS_WIN ? 'tsx.cmd' : 'tsx',
  );

  if (IS_WIN) {
    // .cmd batch file. PATH prepend so spawned children find node.exe.
    // %* forwards stdio handles + any args Chrome passes to the NM host.
    if (opts.dev) {
      return [
        '@echo off',
        `set "PATH=${nodeDir};%PATH%"`,
        `"${tsxBinAbs}" "${bridgeEntryAbs}" %*`,
      ].join('\r\n') + '\r\n';
    }
    return [
      '@echo off',
      `set "PATH=${nodeDir};%PATH%"`,
      `"${nodeBin}" "${bridgeEntryAbs}" %*`,
    ].join('\r\n') + '\r\n';
  }

  if (opts.dev) {
    return `#!/bin/sh
export PATH="${nodeDir}:$PATH"
exec "${tsxBinAbs}" "${bridgeEntryAbs}" "$@"
`;
  }
  return `#!/bin/sh
export PATH="${nodeDir}:$PATH"
exec "${nodeBin}" "${bridgeEntryAbs}" "$@"
`;
}

export function install(opts: InstallOptions): void {
  if (!IS_WIN) process.umask(0o077); // umask is meaningless on Windows

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

  // 4. launcher script. On Windows it's a .cmd, on Unix it's a #!/bin/sh.
  const launcherBody = buildLauncherBody(opts);
  fs.writeFileSync(LAUNCHER_PATH, launcherBody, { mode: IS_WIN ? 0o644 : 0o755 });

  // 5. NM manifests per browser. On Win this writes a JSON + a registry
  //    key; on Unix it writes the JSON into the browser's NM dir.
  const manifest = {
    name: NATIVE_HOST_NAME,
    description: 'byob local bridge for AI agents',
    path: LAUNCHER_PATH,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };
  const manifestJson = JSON.stringify(manifest, null, 2);

  const written: string[] = [];
  for (const b of browserEntries()) {
    if (!b.installed()) continue;
    try {
      b.register(manifestJson);
      written.push(b.name);
    } catch (err) {
      console.warn(`  ⚠ failed to register ${b.name}: ${(err as Error).message}`);
    }
  }

  // 6. user-facing summary + next-steps
  const tsxBin = path.join(
    opts.repoRoot,
    'packages/mcp-server/node_modules/.bin',
    IS_WIN ? 'tsx.cmd' : 'tsx',
  );
  const mcpEntry = path.join(opts.repoRoot, 'packages/mcp-server/bin/byob-mcp.ts');
  const mcpAddCmd = `claude mcp add byob -s user -- ${tsxBin} ${mcpEntry}`;

  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  byob install — done');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Key:        ${PEM_PATH}`);
  console.log(`  Extension:  ${extensionId}`);
  console.log(`  Launcher:   ${LAUNCHER_PATH}`);
  console.log(
    `  NM manifests written: ${written.length === 0 ? '(none — no supported browser detected)' : written.join(', ')}`,
  );
  if (extOutputDir) console.log(`  Built ext:  ${extOutputDir}`);
  console.log('');

  // Auto-open chrome://extensions where we know how (mac / win).
  const chromeOpened = openExtensionsPage();
  // Auto-copy the mcp-add command to the clipboard where we know how.
  const claudeOnPath = isClaudeCliInstalled();
  const copied = copyToClipboard(mcpAddCmd);
  const pasteKey = IS_WIN ? 'Ctrl+V' : '⌘V';
  const quitKey = IS_WIN ? 'close every Chrome window' : 'quit Chrome with ⌘Q';

  console.log('Four more clicks and you are done:');
  console.log('');
  console.log('  ① Load the extension into Chrome');
  if (chromeOpened) {
    console.log('     Chrome just opened chrome://extensions for you.');
  } else {
    console.log('     Open chrome://extensions in Chrome.');
  }
  console.log('     - Top-right: turn ON "Developer mode"');
  console.log('     - Top-left: click "Load unpacked"');
  if (extOutputDir) console.log(`     - Pick the folder: ${extOutputDir}`);
  console.log('');

  console.log('  ② Restart Chrome');
  console.log(`     ${quitKey} (closing only the tab is NOT enough), then reopen.`);
  console.log('     Chrome only reads the new bridge manifest at startup.');
  console.log('');

  console.log('  ③ Register byob with Claude Code');
  if (copied) {
    console.log(`     The command is in your clipboard. Paste it (${pasteKey}) and hit Enter:`);
  } else {
    console.log('     Run this in your terminal:');
  }
  console.log(`       ${mcpAddCmd}`);
  console.log('     (Append `-e BYOB_ALLOW_EVAL=1` after `-s user` to enable browser_eval.)');
  if (!claudeOnPath && (IS_MAC || IS_WIN)) {
    console.log('     ⚠ `claude` CLI not found — install Claude Code first:');
    console.log('       https://docs.claude.com/en/docs/claude-code/quickstart');
  }
  console.log('');

  console.log('  ④ Verify');
  console.log('       byob doctor');
  console.log('     Expect 4 green ✓ — that means everything is wired.');
  console.log('');
}
