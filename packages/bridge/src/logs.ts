import * as fs from 'node:fs';
import { LOG_PATH } from './paths.js';

export async function tailLog(opts: { follow?: boolean }): Promise<void> {
  if (!fs.existsSync(LOG_PATH)) {
    console.error(`No log at ${LOG_PATH} yet (bridge has not started).`);
    return;
  }
  // Print the last ~200 lines first. Read only the file's tail: the log can
  // grow to megabytes between rotations.
  const TAIL_BYTES = 256 * 1024;
  const total = fs.statSync(LOG_PATH).size;
  const start = Math.max(0, total - TAIL_BYTES);
  const fd = fs.openSync(LOG_PATH, 'r');
  const tail = Buffer.alloc(total - start);
  fs.readSync(fd, tail, 0, tail.length, start);
  fs.closeSync(fd);
  const lines = tail.toString('utf-8').split('\n');
  if (start > 0) lines.shift(); // probably a partial line
  process.stdout.write(lines.slice(-200).join('\n'));

  if (!opts.follow) return;
  // tail -f via fs.watch
  let size = fs.statSync(LOG_PATH).size;
  fs.watch(LOG_PATH, { persistent: true }, () => {
    let cur: number;
    try {
      cur = fs.statSync(LOG_PATH).size;
    } catch {
      return;
    }
    if (cur > size) {
      const fd = fs.openSync(LOG_PATH, 'r');
      const buf = Buffer.alloc(cur - size);
      fs.readSync(fd, buf, 0, cur - size, size);
      fs.closeSync(fd);
      process.stdout.write(buf.toString('utf-8'));
      size = cur;
    } else if (cur < size) {
      size = cur; // truncated
    }
  });
}
