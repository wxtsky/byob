import { describe, expect, it } from 'bun:test';
import { readIoStream } from '../io-stream.js';

/** CDP's IO domain in miniature: serves `bytes` in reads of at most `size`, base64-encoded the way Chrome does. */
function fakeStream(bytes: Uint8Array) {
  let pos = 0;
  const calls: string[] = [];
  return {
    calls,
    async send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      calls.push(method);
      if (method !== 'IO.read') return {} as T;
      const part = bytes.subarray(pos, pos + (params.size as number));
      pos += part.length;
      return { base64Encoded: true, data: Buffer.from(part).toString('base64'), eof: pos >= bytes.length } as T;
    },
  };
}

/** Deterministic bytes, so a failure shows the same offset every run. */
function bytesOf(n: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(n);
  let x = 12345;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

const decoded = (b64: string) => new Uint8Array(Buffer.from(b64, 'base64'));
const signal = new AbortController().signal;

describe('readIoStream', () => {
  it('a PDF larger than one 512 KiB read decodes back to every byte', async () => {
    // The size Page.printToPDF produced for a 28-page exam paper.
    const pdf = bytesOf(1_872_695);
    const b64 = await readIoStream(fakeStream(pdf), 'stream-1', signal);
    expect(decoded(b64).length).toBe(pdf.length);
    expect(decoded(b64)).toEqual(pdf);
  });

  it('reads whose size is not a multiple of 3 still join cleanly', async () => {
    const data = bytesOf(10);
    expect(decoded(await readIoStream(fakeStream(data), 's', signal, 4))).toEqual(data);
  });

  it('a stream that fits in one read is returned as is', async () => {
    const data = bytesOf(1000);
    expect(decoded(await readIoStream(fakeStream(data), 's', signal))).toEqual(data);
  });

  it('closes the stream', async () => {
    const s = fakeStream(bytesOf(5));
    await readIoStream(s, 's', signal);
    expect(s.calls.at(-1)).toBe('IO.close');
  });
});
