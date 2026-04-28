// Chrome's NM protocol caps ext→host frames at 64 MiB. A length larger than
// this is either corruption or a hostile sender; refuse to allocate.
export const MAX_FRAME_BYTES = 64 * 1024 * 1024;

export function encodeFrame(msg: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(msg), 'utf-8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

export interface DecodeResult {
  messages: unknown[];
  rest: Buffer;
  /** Set when the frame stream is unrecoverably out of sync. Caller should
   *  destroy the underlying stream rather than try to advance past `rest`. */
  fatal?: string;
}

export function decodeFrames(buffer: Buffer): DecodeResult {
  const messages: unknown[] = [];
  let cursor = buffer;
  while (cursor.length >= 4) {
    const len = cursor.readUInt32LE(0);
    if (len > MAX_FRAME_BYTES) {
      // We could be looking at random bytes from a corrupted upstream.
      // Don't advance the cursor (the bad length is already part of it) —
      // signal fatal and let the caller drop the stream.
      return {
        messages,
        rest: cursor,
        fatal: `frame length ${len} exceeds ${MAX_FRAME_BYTES} (likely corruption)`,
      };
    }
    if (cursor.length < 4 + len) break;
    const body = cursor.subarray(4, 4 + len).toString('utf-8');
    try {
      messages.push(JSON.parse(body));
    } catch (e) {
      // Surface to stderr so the bridge log captures it. Cursor still
      // advances past this frame so subsequent valid frames keep flowing —
      // a single bad JSON body shouldn't kill the whole channel.
      console.error(
        `[byob/nm] decodeFrames JSON.parse failed (len=${len}): ${(e as Error).message}`,
      );
    }
    cursor = cursor.subarray(4 + len);
  }
  return { messages, rest: cursor };
}

export function writeFrameToStdout(msg: unknown): void {
  process.stdout.write(encodeFrame(msg));
}

export function startStdinReader(onMessage: (msg: unknown) => void): void {
  let buf: Buffer = Buffer.alloc(0);
  process.stdin.on('data', (chunk: Uint8Array) => {
    buf = Buffer.concat([buf, chunk]);
    const { messages, rest, fatal } = decodeFrames(buf);
    buf = rest;
    for (const m of messages) onMessage(m);
    if (fatal) {
      console.error(`[byob/nm] fatal frame error, destroying stdin: ${fatal}`);
      // Cleanest way to surface the error: drop the stream, the bridge
      // shutdown path picks it up via 'end'/'close' and exits gracefully.
      process.stdin.destroy();
    }
  });
}
