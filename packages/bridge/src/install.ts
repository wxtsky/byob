import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { computeExtensionId } from './extension-id.js';
import { BYOB_DIR, LAUNCHER_PATH, BRIDGES_DIR } from './paths.js';
import { askLang, setLang, t } from './install/messages.js';
import { browserEntries, NATIVE_HOST_NAME } from './install/browser-entries.js';
import { copyToClipboard, waitForBridge } from './install/tty.js';
import { promptMcpRegistration } from './install/mcp-clients.js';

const PEM_PATH = path.join(BYOB_DIR, 'extension-key.pem');
const IS_WIN = process.platform === 'win32';

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
  const outDir = path.join(extDir, 'output/chrome-mv3');
  if (!fs.existsSync(outDir)) {
    throw new Error(`extension build did not produce ${outDir}`);
  }
  return outDir;
}

/**
 * Resolve `node_modules/.bin/tsx` for a workspace package. On Windows this
 * is the touchy bit — bun generates `.exe` shims, npm generates `.cmd`
 * shims, and we don't know which one the user ran. The hard-coded
 * `tsx.cmd` we used to ship broke every bun-installed Windows setup
 * (project's `bun.lock` is the recommended path) and showed up as the
 * NM host launching and immediately dying.
 */
function resolveTsxBin(repoRoot: string, pkg: 'bridge' | 'mcp-server'): string {
  const dir = path.join(repoRoot, 'packages', pkg, 'node_modules/.bin');
  if (!IS_WIN) return path.join(dir, 'tsx');
  const exe = path.join(dir, 'tsx.exe');
  if (fs.existsSync(exe)) return exe;
  return path.join(dir, 'tsx.cmd');
}

/** Build the per-platform launcher script body. */
function buildLauncherBody(opts: InstallOptions): string {
  const nodeBin = process.execPath;
  const nodeDir = path.dirname(nodeBin);
  const bridgeEntryAbs = path.join(opts.repoRoot, 'packages/bridge/bin/byob-bridge.ts');
  const tsxBinAbs = resolveTsxBin(opts.repoRoot, 'bridge');

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

export async function install(opts: InstallOptions): Promise<void> {
  if (!IS_WIN) process.umask(0o077); // umask is meaningless on Windows

  // 1. dirs. BRIDGES_DIR is unused on Windows (sockets are Named Pipes,
  // not files) — skip the empty-dir creation there.
  fs.mkdirSync(BYOB_DIR, { recursive: true, mode: 0o700 });
  if (!IS_WIN) fs.mkdirSync(BRIDGES_DIR, { recursive: true, mode: 0o700 });

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

  // 6. language selection + user-facing summary
  setLang(await askLang());

  const tsxBin = resolveTsxBin(opts.repoRoot, 'mcp-server');
  const mcpEntry = path.join(opts.repoRoot, 'packages/mcp-server/bin/byob-mcp.ts');

  const mcpJsonObj = {
    mcpServers: {
      byob: {
        command: tsxBin,
        args: [mcpEntry],
      },
    },
  };

  // ANSI palette. Centralised here so the layout below stays scannable.
  const G = '\x1b[32m';        // green
  const Gb = '\x1b[1;32m';     // bold green
  const Yb = '\x1b[1;33m';     // bold yellow
  const C = '\x1b[36m';        // cyan
  const U = '\x1b[4m';         // underline
  const B = '\x1b[1m';         // bold
  const D = '\x1b[2m';         // dim
  const R = '\x1b[0m';         // reset
  const SUCCESS_BADGE = '\x1b[42;30m  ✓  \x1b[0m'; // green bg, black fg
  const TIMEOUT_BADGE = '\x1b[43;30m  ⏰  \x1b[0m'; // yellow bg, black fg
  const RULE = '━'.repeat(60);

  console.log('');
  console.log(`${B}${RULE}${R}`);
  console.log(`${B}${G}✓${R}${B} ${t('installDone')}${R}  ${D}— ${t('installSubtitle')}${R}`);
  console.log(`${B}${RULE}${R}`);
  console.log(`${D}Extension${R}  ${extensionId}`);
  console.log(`${D}NM hosts${R}   ${written.length === 0 ? '(none)' : written.join(', ')}`);
  if (extOutputDir) {
    const copied = copyToClipboard(extOutputDir);
    const tail = copied ? `  ${D}${t('clipboardCopied')}${R}` : '';
    console.log(`${D}Built to${R}   ${C}${B}${U}${extOutputDir}${R}${tail}`);
  }
  console.log('');

  console.log(`${B}${t('nextSteps')}${R}`);

  console.log('');
  console.log(`${G}①${R} ${B}${t('step1Title')}${R}`);
  console.log(`   ${t('step1Open')}`);
  console.log(`   ${D}•${R} ${t('step1Dev')}`);
  console.log(`   ${D}•${R} ${t('step1Load')}`);
  if (extOutputDir) console.log(`   ${D}•${R} ${t('step1Pick')} ${C}${B}${U}${extOutputDir}${R}`);

  console.log('');
  console.log(`${G}②${R} ${B}${t('step2Title')}${R}`);
  console.log(`   ${t('step2Quit')}`);
  console.log(`   ${D}${t('step2Why')}${R}`);

  console.log('');
  console.log(`${G}③${R} ${B}${t('step3Title')}${R}`);
  console.log('');
  await promptMcpRegistration(tsxBin, mcpEntry, mcpJsonObj);

  console.log('');
  console.log(`${G}④${R} ${B}${t('step4Title')}${R}`);
  console.log(`   ${D}${t('step4Hint')}${R}`);

  const online = await waitForBridge();
  console.log('');
  if (online) {
    console.log(`${SUCCESS_BADGE}  ${Gb}${t('step4OnlineHeadline')}${R}`);
    console.log('');
    console.log(`   ${D}${t('step4OnlineTry')}${R}  ${B}${t('step4OnlineExample')}${R}`);
  } else {
    console.log(`${TIMEOUT_BADGE}  ${Yb}${t('step4TimeoutHeadline')}${R}`);
    console.log('');
    console.log(`   ${B}${t('step4CommonCauses')}${R}`);
    console.log(`     1. ${t('step4Tip1')}`);
    console.log(`     2. ${t('step4Tip2')}`);
    console.log(`     3. ${t('step4Tip3')}`);
    console.log('');
    console.log(`   ${D}${t('step4DoctorRetry')}${R}`);
  }
  console.log('');
}
