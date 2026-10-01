import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { BYOB_DIR } from '../paths.js';

export const NATIVE_HOST_NAME = 'ai.byob.bridge';

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
export interface BrowserEntry {
  name: string;
  manifestPath: string;
  installed: () => boolean;
  /** Persist the manifest so this browser will pick it up. */
  register: (manifestJson: string) => void;
  /** Windows: the HKCU key the browser reads the manifest path from. */
  regKey?: string;
}

/** Every browser byob knows on this platform, installed or not. */
export function browserEntries(): BrowserEntry[] {
  const home = os.homedir();
  const manifestIn = (dataDir: string): string =>
    path.join(dataDir, 'NativeMessagingHosts', `${NATIVE_HOST_NAME}.json`);
  switch (process.platform) {
    case 'darwin': {
      // Installed = the app is in /Applications or ~/Applications (non-admin
      // installs), or the browser has already created its profile folder.
      const mac = (name: string, app: string, dataDir: string): BrowserEntry => {
        const data = path.join(home, 'Library/Application Support', dataDir);
        return fsBrowserEntry(name, manifestIn(data), () =>
          fs.existsSync(`/Applications/${app}.app`) ||
          fs.existsSync(path.join(home, 'Applications', `${app}.app`)) ||
          fs.existsSync(data),
        );
      };
      return [
        mac('Chrome', 'Google Chrome', 'Google/Chrome'),
        mac('Brave', 'Brave Browser', 'BraveSoftware/Brave-Browser'),
        mac('Edge', 'Microsoft Edge', 'Microsoft Edge'),
      ];
    }
    case 'linux': {
      // Chrome and Brave always get a manifest (their config folder may not
      // exist before the first launch); the others only once they have one.
      const linux = (name: string, dataDir: string, always: boolean): BrowserEntry => {
        const data = path.join(home, '.config', dataDir);
        return fsBrowserEntry(name, manifestIn(data), always ? () => true : () => fs.existsSync(data));
      };
      return [
        linux('Chrome', 'google-chrome', true),
        linux('Brave', 'BraveSoftware/Brave-Browser', true),
        linux('Chromium', 'chromium', false),
        linux('Edge', 'microsoft-edge', false),
      ];
    }
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

/** Write `content` unless the file already holds exactly that. */
function writeIfChanged(file: string, content: string): void {
  try {
    if (fs.readFileSync(file, 'utf8') === content) return;
  } catch {
    // missing — write it
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/**
 * Default macOS / Linux browser entry: just write the manifest JSON file.
 * An unchanged manifest isn't rewritten, so its mtime keeps meaning "when
 * the browser last needed a restart" (see doctor).
 */
export function fsBrowserEntry(
  name: string,
  manifestPath: string,
  installed: () => boolean,
): BrowserEntry {
  return {
    name,
    manifestPath,
    installed,
    register: (manifestJson: string) => writeIfChanged(manifestPath, manifestJson),
  };
}

/**
 * Windows browser entry: write the manifest under ~/.byob/ and point a
 * `HKCU\...\NativeMessagingHosts\<host>` registry key at it. We don't try
 * to detect whether Chrome is actually installed (it can live in a half-
 * dozen places) — writing an unused HKCU key is harmless, so we always
 * register and let the user decide.
 */
export function winBrowserEntry(name: string, manifestPath: string, regKey: string): BrowserEntry {
  return {
    name,
    manifestPath,
    regKey,
    installed: () => true,
    register: (manifestJson: string) => {
      writeIfChanged(manifestPath, manifestJson);
      // `reg add` overwrites the (Default) value with /f and creates the
      // key if it doesn't exist. Use spawnSync (no shell) so spaces and
      // quotes inside paths can't break out of the command line. Earlier
      // execSync version was a shell-injection waiting to happen if any
      // future caller produced a manifestPath containing a `"`.
      const r = spawnSync(
        'reg',
        ['add', regKey, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'],
        { stdio: 'pipe' },
      );
      if (r.status !== 0) {
        const stderr = r.stderr?.toString().trim() ?? '';
        throw new Error(`reg add failed (exit ${r.status}): ${stderr || 'no stderr'}`);
      }
    },
  };
}
