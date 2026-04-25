import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { BYOB_DIR, LAUNCHER_PATH } from './paths.js';

const NM_NAME = 'ai.byob.bridge';

interface RemovalTarget {
  /** Human label for the log line. */
  label: string;
  /** Best-effort removal — must swallow its own errors and call `console.log` on success. */
  remove: () => void;
}

function unixManifests(): RemovalTarget[] {
  const home = os.homedir();
  const dirs =
    process.platform === 'darwin'
      ? [
          path.join(home, 'Library/Application Support/Google/Chrome/NativeMessagingHosts'),
          path.join(
            home,
            'Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts',
          ),
          path.join(home, 'Library/Application Support/Microsoft Edge/NativeMessagingHosts'),
        ]
      : process.platform === 'linux'
        ? [
            path.join(home, '.config/google-chrome/NativeMessagingHosts'),
            path.join(home, '.config/BraveSoftware/Brave-Browser/NativeMessagingHosts'),
          ]
        : [];

  return dirs.map((dir) => {
    const file = path.join(dir, `${NM_NAME}.json`);
    return {
      label: file,
      remove: () => {
        if (fs.existsSync(file)) {
          fs.unlinkSync(file);
          console.log(`removed ${file}`);
        }
      },
    };
  });
}

function winRemovals(): RemovalTarget[] {
  const browsers: Array<[string, string]> = [
    ['chrome', `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NM_NAME}`],
    ['brave', `HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\${NM_NAME}`],
    ['edge', `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${NM_NAME}`],
  ];
  const targets: RemovalTarget[] = [];
  for (const [browser, regKey] of browsers) {
    targets.push({
      label: regKey,
      remove: () => {
        try {
          execSync(`reg delete "${regKey}" /f`, { stdio: 'pipe' });
          console.log(`removed ${regKey}`);
        } catch {
          // Key didn't exist — fine.
        }
      },
    });
    const manifestFile = path.join(BYOB_DIR, `${NM_NAME}.${browser}.json`);
    targets.push({
      label: manifestFile,
      remove: () => {
        if (fs.existsSync(manifestFile)) {
          fs.unlinkSync(manifestFile);
          console.log(`removed ${manifestFile}`);
        }
      },
    });
  }
  return targets;
}

export function uninstall(): void {
  if (fs.existsSync(LAUNCHER_PATH)) {
    fs.unlinkSync(LAUNCHER_PATH);
    console.log(`removed ${LAUNCHER_PATH}`);
  }
  const targets = process.platform === 'win32' ? winRemovals() : unixManifests();
  for (const t of targets) t.remove();
  console.log('Done. Reload the extension in Chrome to drop any existing connection.');
}
