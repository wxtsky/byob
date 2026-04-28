import { spawnSync } from 'node:child_process';
import { listAliveBridges } from '../bridge-registry.js';
import { t } from './messages.js';

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

/**
 * Pipe `text` into the system clipboard.
 * - macOS: `pbcopy`
 * - Windows: `clip` (built-in, reads stdin)
 * - Linux: silent no-op (no universal clipboard tool).
 */
export function copyToClipboard(text: string): boolean {
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

/**
 * After setup we don't hand the user back to the prompt — we hang here and
 * poll for an alive bridge. The user has clear feedback that the system is
 * waiting on THEM (load extension + restart Chrome), not the other way
 * around. Spinner refreshes at 10Hz, registry polled every 5th frame.
 *
 * Stays cross-platform: TTY paints a single self-rewriting line; non-TTY
 * (CI, piped) prints a dim line every 10s instead of trying to use \r.
 */
export async function waitForBridge(timeoutMs = 5 * 60 * 1000): Promise<boolean> {
  const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const FRAME_MS = 100;
  const POLL_EVERY = 5; // poll registry every 5 frames (500ms)
  const isTty = process.stdout.isTTY === true;
  const start = Date.now();
  let frame = 0;
  let lastLogged = -1;

  while (Date.now() - start < timeoutMs) {
    if (frame % POLL_EVERY === 0) {
      const alive = listAliveBridges();
      if (alive.length > 0) {
        if (isTty) process.stdout.write('\r\x1b[2K');
        return true;
      }
    }
    const elapsed = Math.floor((Date.now() - start) / 1000);
    if (isTty) {
      const spin = SPINNER[frame % SPINNER.length];
      process.stdout.write(
        `\r\x1b[2K   \x1b[2m${spin} ${t('step4Waiting')}… (${elapsed}s)\x1b[0m`,
      );
    } else if (elapsed > 0 && elapsed % 10 === 0 && elapsed !== lastLogged) {
      console.log(`   ${t('step4Waiting')}… (${elapsed}s)`);
      lastLogged = elapsed;
    }
    frame++;
    await new Promise((r) => setTimeout(r, FRAME_MS));
  }
  if (isTty) process.stdout.write('\r\x1b[2K');
  return false;
}

export interface ToolChoice {
  name: string;
  selected: boolean;
}

export function multiSelect(items: ToolChoice[]): Promise<boolean[]> {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      resolve(items.map(() => false));
      return;
    }

    let cursor = 0;
    const selected = items.map((i) => i.selected);

    const render = (): void => {
      // Move cursor up to redraw (skip first render)
      process.stdout.write(`\x1b[${items.length}A`);
      for (let i = 0; i < items.length; i++) {
        const check = selected[i] ? '●' : '○';
        const arrow = i === cursor ? '→' : ' ';
        const highlight = i === cursor ? '\x1b[1m' : '\x1b[2m';
        process.stdout.write(`\x1b[2K   ${arrow} ${check} ${highlight}${items[i]!.name}\x1b[0m\n`);
      }
    };

    // Initial draw
    for (let i = 0; i < items.length; i++) {
      const check = selected[i] ? '●' : '○';
      const arrow = i === cursor ? '→' : ' ';
      const highlight = i === cursor ? '\x1b[1m' : '\x1b[2m';
      process.stdout.write(`   ${arrow} ${check} ${highlight}${items[i]!.name}\x1b[0m\n`);
    }

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    const onData = (key: string): void => {
      if (key === '\x03') {
        // Ctrl+C
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener('data', onData);
        process.exit(0);
      }
      if (key === ' ') {
        selected[cursor] = !selected[cursor];
        render();
      } else if (key === '\x1b[A' || key === 'k') {
        // Up
        cursor = (cursor - 1 + items.length) % items.length;
        render();
      } else if (key === '\x1b[B' || key === 'j') {
        // Down
        cursor = (cursor + 1) % items.length;
        render();
      } else if (key === '\r' || key === '\n') {
        // Enter
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener('data', onData);
        resolve(selected);
      }
    };

    process.stdin.on('data', onData);
  });
}
