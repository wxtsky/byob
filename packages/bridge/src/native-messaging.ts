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
  // Accumulate inbound chunks in an array and only do a single Buffer.concat
  // when we have enough bytes for the next frame. This avoids the O(N²)
  // copy that `buf = Buffer.concat([buf, chunk])` produces on multi-megabyte
  // PDF/screenshot frames split across many TCP/pipe chunks.
  let pending: Buffer[] = [];
  let pendingLen = 0;

  function consume(): { fatal?: string } {
    while (pendingLen >= 4) {
      // Peek the 4-byte length header without flattening everything yet.
      // First chunk almost always has it intact; if not, splice just enough.
      let header: Buffer;
      const first = pending[0];
      if (first && first.length >= 4) {
        header = first;
      } else {
        // Combine just enough bytes to read the header.
        let acc = 0;
        const bits: Buffer[] = [];
        for (const c of pending) {
          bits.push(c);
          acc += c.length;
          if (acc >= 4) break;
        }
        header = Buffer.concat(bits, acc);
      }
      const len = header.readUInt32LE(0);
      if (len > MAX_FRAME_BYTES) {
        return { fatal: `frame length ${len} exceeds ${MAX_FRAME_BYTES} (likely corruption)` };
      }
      const need = 4 + len;
      if (pendingLen < need) break;

      // We have a full frame's worth of bytes in `pending`. Materialize it
      // exactly once.
      const flat = pending.length === 1 ? pending[0]! : Buffer.concat(pending, pendingLen);
      const body = flat.subarray(4, need).toString('utf-8');
      const tail = flat.subarray(need);
      pending = tail.length > 0 ? [tail] : [];
      pendingLen = tail.length;

      try {
        onMessage(JSON.parse(body));
      } catch (e) {
        // Surface to stderr so the bridge log captures it. We've already
        // consumed this frame from `pending`, so subsequent valid frames
        // keep flowing — a single bad JSON body shouldn't kill the channel.
        console.error(
          `[byob/nm] decodeFrames JSON.parse failed (len=${len}): ${(e as Error).message}`,
        );
      }
    }
    return {};
  }

  process.stdin.on('data', (chunk: Uint8Array) => {
    const buf = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    pending.push(buf);
    pendingLen += buf.length;
    const { fatal } = consume();
    if (fatal) {
      console.error(`[byob/nm] fatal frame error, destroying stdin: ${fatal}`);
      // Cleanest way to surface the error: drop the stream, the bridge
      // shutdown path picks it up via 'end'/'close' and exits gracefully.
      process.stdin.destroy();
    }
  });
}
