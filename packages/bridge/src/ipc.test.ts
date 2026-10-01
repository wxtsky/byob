// Drives a real bridge process over its stdin/stdout (standing in for the
// extension) and its IPC socket (standing in for the MCP server). BYOB_HOME
// points at a temp dir (scripts/test-preload.ts), never ~/.byob.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { VERSION } from '@byob/shared';
import { encodeFrame } from './native-messaging.js';
import { LOG_PATH, socketPathFor } from './paths.js';

const BRIDGE_ENTRY = path.resolve(import.meta.dir, '../bin/byob-bridge.ts');
const TSX_BIN = path.resolve(import.meta.dir, '../node_modules/.bin/tsx');

type Frame = Record<string, unknown>;

/** Collects every frame the bridge writes to "the extension". */
class ExtensionSide {
  readonly frames: Frame[] = [];
  private buffered = Buffer.alloc(0);
  private waiters: Array<() => void> = [];

  constructor(readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on('data', (chunk: Buffer) => {
      this.buffered = Buffer.concat([this.buffered, chunk]);
      while (this.buffered.length >= 4) {
        const len = this.buffered.readUInt32LE(0);
        if (this.buffered.length < 4 + len) break;
        this.frames.push(JSON.parse(this.buffered.subarray(4, 4 + len).toString('utf8')) as Frame);
        this.buffered = this.buffered.subarray(4 + len);
      }
      for (const w of this.waiters.splice(0)) w();
    });
  }

  send(msg: unknown): void {
    this.child.stdin.write(encodeFrame(msg));
  }

  async waitFor(pred: (f: Frame) => boolean, timeoutMs = 3_000): Promise<Frame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.frames.find(pred);
      if (hit) return hit;
      if (Date.now() > deadline) throw new Error(`no matching frame; got ${JSON.stringify(this.frames)}`);
      await new Promise<void>((r) => {
        this.waiters.push(r);
        setTimeout(r, 100);
      });
    }
  }
}

function request(
  socketPath: string,
  method: 'GET' | 'POST',
  route: string,
  body?: unknown,
): { done: Promise<{ status: number; body: Frame }>; req: http.ClientRequest } {
  const data = body === undefined ? '' : JSON.stringify(body);
  let req!: http.ClientRequest;
  const done = new Promise<{ status: number; body: Frame }>((resolve, reject) => {
    req = http.request(
      { socketPath, path: route, method, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(buf) as Frame }));
      },
    );
    req.on('error', reject);
    req.end(data);
  });
  return { done, req };
}

const deviceId = `ipc-${crypto.randomUUID()}`;
const socket = socketPathFor(deviceId);
let ext: ExtensionSide;

beforeAll(async () => {
  ext = new ExtensionSide(spawn(TSX_BIN, [BRIDGE_ENTRY], { stdio: ['pipe', 'pipe', 'pipe'] }));
  ext.send({ type: 'hello', deviceId, version: '9.9.9' });
  await ext.waitFor((f) => f.type === 'status' && f.status === 'ready');
});

afterAll(async () => {
  ext.child.stdin.end();
  await new Promise((r) => {
    if (ext.child.exitCode !== null) return r(null);
    ext.child.once('exit', r);
    setTimeout(() => {
      ext.child.kill('SIGTERM');
      r(null);
    }, 2_000);
  });
});

test('/status reports the bridge and extension versions', async () => {
  const { done } = request(socket, 'GET', '/status');
  const { status, body } = await done;
  expect(status).toBe(200);
  expect(body).toMatchObject({ connected: true, deviceId, version: VERSION, extensionVersion: '9.9.9' });
});

test('a client that disconnects mid-call cancels the command', async () => {
  const requestId = `mcp-${crypto.randomUUID()}`;
  const { done, req } = request(socket, 'POST', '/call', { command: 'snapshot', params: {}, _requestId: requestId });
  done.catch(() => undefined);
  const cmd = await ext.waitFor((f) => f.type === 'command' && f.command === 'snapshot');
  req.destroy();
  await ext.waitFor((f) => f.type === 'cancel' && f.requestId === cmd.requestId);
});

test('a command over 1 MiB is refused instead of breaking the native port', async () => {
  const before = ext.frames.length;
  const { done } = request(socket, 'POST', '/call', { command: 'type', params: { text: 'x'.repeat(1_100_000) } });
  const { body } = await done;
  expect(body.error).toBe('invalid_argument');
  expect(String(body.message)).toContain('1 MiB');
  expect(ext.frames.slice(before).some((f) => f.command === 'type')).toBe(false);
  // The bridge is still usable.
  const { done: status } = request(socket, 'GET', '/status');
  expect((await status).body.connected).toBe(true);
});

test('the log records what a frame is, not what it carries', async () => {
  const secret = `page-text-${crypto.randomUUID()}`;
  const { done } = request(socket, 'POST', '/call', { command: 'read', params: {} });
  const cmd = await ext.waitFor((f) => f.type === 'command' && f.command === 'read');
  ext.send({ type: 'result', requestId: cmd.requestId, text: secret });
  expect((await done).body.text).toBe(secret);
  const log = fs.readFileSync(LOG_PATH, 'utf8');
  expect(log).toContain(`<- result id=${String(cmd.requestId)}`);
  expect(log).not.toContain(secret);
});

test('download_images rejects a relative saveDir', async () => {
  const { done } = request(socket, 'POST', '/download-images', { saveDir: 'pics' });
  const { status, body } = await done;
  expect(status).toBe(400);
  expect(body.error).toBe('invalid_argument');
});
