import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LAUNCHER_PATH } from './paths.js';

const NM_NAME = 'ai.byob.bridge';

function manifestDirsForPlatform(): string[] {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return [
      path.join(home, 'Library/Application Support/Google/Chrome/NativeMessagingHosts'),
      path.join(home, 'Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts'),
      path.join(home, 'Library/Application Support/Microsoft Edge/NativeMessagingHosts'),
    ];
  }
  if (process.platform === 'linux') {
    return [
      path.join(home, '.config/google-chrome/NativeMessagingHosts'),
      path.join(home, '.config/BraveSoftware/Brave-Browser/NativeMessagingHosts'),
    ];
  }
  return [];
}

export function uninstall(): void {
  if (fs.existsSync(LAUNCHER_PATH)) {
    fs.unlinkSync(LAUNCHER_PATH);
    console.log(`removed ${LAUNCHER_PATH}`);
  }
  for (const dir of manifestDirsForPlatform()) {
    const p = path.join(dir, `${NM_NAME}.json`);
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      console.log(`removed ${p}`);
    }
  }
  console.log('Done. Reload the extension in Chrome to drop any existing connection.');
}
