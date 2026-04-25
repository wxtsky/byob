export function encodeFrame(msg: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(msg), 'utf-8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

export function decodeFrames(buffer: Buffer): { messages: unknown[]; rest: Buffer } {
  const messages: unknown[] = [];
  let cursor = buffer;
  while (cursor.length >= 4) {
    const len = cursor.readUInt32LE(0);
    if (cursor.length < 4 + len) break;
    const body = cursor.subarray(4, 4 + len).toString('utf-8');
    try {
      messages.push(JSON.parse(body));
    } catch {
      // malformed body — skip silently to keep the stream alive
    }
    cursor = cursor.subarray(4 + len);
  }
  return { messages, rest: cursor };
}

export function writeFrameToStdout(msg: unknown): void {
  process.stdout.write(encodeFrame(msg));
}

export function startStdinReader(onMessage: (msg: unknown) => void): void {
  let buf = Buffer.alloc(0);
  process.stdin.on('data', (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    const { messages, rest } = decodeFrames(buf);
    buf = rest;
    for (const m of messages) onMessage(m);
  });
}
