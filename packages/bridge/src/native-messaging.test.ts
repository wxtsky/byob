import { test, expect } from 'bun:test';
import { encodeFrame, decodeFrames } from './native-messaging.js';

test('encodeFrame produces 4-byte LE length header + UTF-8 JSON body', () => {
  const buf = encodeFrame({ hello: 'world' });
  const len = buf.readUInt32LE(0);
  expect(len).toBe(buf.length - 4);
  const body = buf.subarray(4).toString('utf-8');
  expect(JSON.parse(body)).toEqual({ hello: 'world' });
});

test('decodeFrames yields complete messages and keeps remainder', () => {
  const a = encodeFrame({ a: 1 });
  const b = encodeFrame({ b: 2 });
  const merged = Buffer.concat([a, b.subarray(0, 3)]);
  const { messages, rest } = decodeFrames(merged);
  expect(messages).toEqual([{ a: 1 }]);
  expect(rest.length).toBe(3);
});

test('decodeFrames handles split header', () => {
  const full = encodeFrame({ x: 'y' });
  const { messages, rest } = decodeFrames(full.subarray(0, 2));
  expect(messages).toEqual([]);
  expect(rest.length).toBe(2);
});
