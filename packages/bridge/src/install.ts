import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { computeExtensionId } from './extension-id.js';
import { BYOB_DIR, LAUNCHER_PATH, BRIDGES_DIR } from './paths.js';

const NATIVE_HOST_NAME = 'ai.byob.bridge';

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
  publicKeyB64: string;
  bridgeEntryAbs: string;   // absolute path to bin/byob-bridge.ts (or compiled .js)
  tsxBinAbs?: string;       // required when dev=true: absolute path to tsx binary
}

export function install(opts: InstallOptions): void {
  process.umask(0o077);

  // 1. ensure dirs
  fs.mkdirSync(BYOB_DIR,    { recursive: true, mode: 0o700 });
  fs.mkdirSync(BRIDGES_DIR, { recursive: true, mode: 0o700 });

  // 2. write launcher shell script
  const nodeBin = process.execPath;
  const nodeDir = path.dirname(nodeBin);
  let launcherBody: string;
  if (opts.dev) {
    if (!opts.tsxBinAbs) throw new Error('tsxBinAbs required for --dev install');
    // Use tsx binary directly: it's an mjs script with its own shebang that handles
    // node + the loader correctly. Avoids the `node --import tsx` resolution pitfall.
    launcherBody = `#!/bin/sh
export PATH="${nodeDir}:$PATH"
exec "${opts.tsxBinAbs}" "${opts.bridgeEntryAbs}" "$@"
`;
  } else {
    launcherBody = `#!/bin/sh
export PATH="${nodeDir}:$PATH"
exec "${nodeBin}" "${opts.bridgeEntryAbs}" "$@"
`;
  }
  fs.writeFileSync(LAUNCHER_PATH, launcherBody, { mode: 0o755 });
  console.log(`  Launcher: ${LAUNCHER_PATH}`);

  // 3. compute extension ID and write manifest per browser
  const extensionId = computeExtensionId(opts.publicKeyB64);
  const manifest = {
    name: NATIVE_HOST_NAME,
    description: 'byob local bridge for AI agents',
    path: LAUNCHER_PATH,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };

  let written = 0;
  for (const b of browserEntries()) {
    if (!b.installed()) {
      console.log(`  - ${b.name} (not installed, skipped)`);
      continue;
    }
    fs.mkdirSync(b.manifestDir, { recursive: true });
    const manifestPath = path.join(b.manifestDir, `${NATIVE_HOST_NAME}.json`);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    console.log(`  ✓ ${b.name}: ${manifestPath}`);
    written++;
  }

  console.log('');
  console.log(`Bridge installed for extension ID: ${extensionId}`);
  console.log(`Wrote ${written} browser manifest(s).`);
  console.log('');
  console.log('Next steps:');
  console.log('  1. cd packages/extension && bun run build');
  console.log('  2. chrome://extensions → enable Developer mode → Load unpacked');
  console.log('     → packages/extension/.output/chrome-mv3');
  console.log('  3. Restart Chrome (or just reload the extension)');
}

/**
 * Read the public key out of the extension's wxt.config.ts manifest.key field.
 */
export function readPublicKeyFromExtensionConfig(repoRoot: string): string {
  const cfg = fs.readFileSync(path.join(repoRoot, 'packages/extension/wxt.config.ts'), 'utf-8');
  const m = cfg.match(/key:\s*['"]([^'"]+)['"]/);
  if (!m || !m[1] || m[1] === 'REPLACE_WITH_BASE64_DER_PUBLIC_KEY') {
    throw new Error(
      'extension public key not set in packages/extension/wxt.config.ts.\n' +
      'Generate one:\n' +
      '  openssl genrsa -out ~/.byob/extension-key.pem 2048\n' +
      '  openssl rsa -in ~/.byob/extension-key.pem -pubout -outform DER | base64 | tr -d "\\n"\n' +
      'and paste the output as manifest.key.',
    );
  }
  return m[1];
}

export function bridgeEntryAbsForDev(repoRoot: string): string {
  return path.join(repoRoot, 'packages/bridge/bin/byob-bridge.ts');
}

export function tsxBinAbs(repoRoot: string): string {
  return path.join(repoRoot, 'packages/bridge/node_modules/.bin/tsx');
}
