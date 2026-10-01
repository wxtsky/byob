import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { startUploadServer, type UploadServer } from './upload-server.js';

let server: UploadServer | null = null;
let dir = '';

afterEach(async () => {
  await server?.close();
  server = null;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

async function setup(maxBytes?: number): Promise<UploadServer> {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'byob-upload-'));
  server = await startUploadServer(dir, maxBytes);
  return server;
}

function post(
  s: UploadServer,
  filename: string,
  write: (req: http.ClientRequest) => void,
): Promise<{ status: number; body: string } | { error: string }> {
  return new Promise((resolve) => {
    let answered = false;
    const req = http.request(
      `${s.endpoint}?filename=${encodeURIComponent(filename)}`,
      { method: 'POST', headers: { Authorization: `Bearer ${s.secret}` } },
      (res) => {
        answered = true;
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', (e) => resolve({ error: e.message }));
    // A request destroyed before any response emits only 'close'.
    req.on('close', () => {
      if (!answered) resolve({ error: 'closed' });
    });
    write(req);
  });
}

const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test('saves an upload under saveDir', async () => {
  const s = await setup();
  const r = await post(s, 'cat.png', (req) => req.end('hello'));
  expect(r).toMatchObject({ status: 200 });
  expect(fs.readFileSync(path.join(dir, 'cat.png'), 'utf8')).toBe('hello');
});

test('an upload over the limit leaves no partial file', async () => {
  const s = await setup(10);
  await post(s, 'big.bin', (req) => {
    req.write('0123456789');
    req.end('0123456789');
  });
  await pause(100);
  expect(fs.readdirSync(dir)).toEqual([]);
});

test('an aborted upload leaves no partial file', async () => {
  const s = await setup();
  void post(s, 'half.jpg', (req) => {
    req.write('partial bytes');
    setTimeout(() => req.destroy(), 50);
  });
  await pause(300);
  expect(fs.readdirSync(dir)).toEqual([]);
});

test('a wrong secret is refused', async () => {
  const s = await setup();
  const r = await post({ ...s, secret: 'nope' }, 'x.png', (req) => req.end('x'));
  expect(r).toMatchObject({ status: 403 });
  expect(fs.readdirSync(dir)).toEqual([]);
});
