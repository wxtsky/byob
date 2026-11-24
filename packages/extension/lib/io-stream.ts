/**
 * Read a CDP stream (IO.read) to the end and return its bytes as one base64
 * string — e.g. Page.printToPDF with transferMode: 'ReturnAsStream'.
 *
 * Each read comes back base64-encoded on its own. A read that isn't a multiple
 * of 3 bytes (512 KiB isn't) ends in '=' padding, so joining the strings puts
 * padding mid-way and decoders stop there: Node's Buffer.from kept only the
 * first 512 KiB of a 1.8 MB PDF. So decode every read and encode once.
 */
import type { CdpSession } from './cdp.js';
import { throwIfAborted } from './signal-utils.js';

export async function readIoStream(
  session: Pick<CdpSession, 'send'>,
  handle: string,
  signal: AbortSignal,
  size = 512 * 1024,
): Promise<string> {
  let binary = '';
  try {
    for (;;) {
      throwIfAborted(signal);
      // printToPDF streams are binary, so Chrome always base64-encodes the reads.
      const c = await session.send<{ data: string; eof: boolean }>('IO.read', { handle, size }, signal);
      if (c.data) binary += atob(c.data);
      if (c.eof) break;
    }
  } finally {
    await session.send('IO.close', { handle }).catch(() => {});
  }
  return btoa(binary);
}
