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
}

export function browserEntries(): BrowserEntry[] {
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
export function fsBrowserEntry(
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
export function winBrowserEntry(name: string, manifestPath: string, regKey: string): BrowserEntry {
  return {
    name,
    manifestPath,
    installed: () => true,
    register: (manifestJson: string) => {
      fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
      fs.writeFileSync(manifestPath, manifestJson);
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
