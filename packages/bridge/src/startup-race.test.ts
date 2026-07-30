import { expect, test } from 'bun:test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { encodeFrame } from './native-messaging.js';
import { LOG_PATH, REGISTRY_PATH, socketPathFor } from './paths.js';

const BRIDGE_ENTRY = path.resolve(import.meta.dir, '../bin/byob-bridge.ts');
const TSX_BIN = path.resolve(import.meta.dir, '../node_modules/.bin/tsx');
const NATIVE_ORIGIN = 'chrome-extension://bkpghpogpdfknloabjaeidkkeoaedjhk/';

function spawnBridge(): ChildProcessWithoutNullStreams {
  return spawn(TSX_BIN, [BRIDGE_ENTRY, NATIVE_ORIGIN], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function hello(deviceId: string): Buffer {
  return encodeFrame({ type: 'hello', deviceId });
}

function readOneFrame(child: ChildProcessWithoutNullStreams, timeoutMs = 2_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for native frame from pid ${child.pid}`));
    }, timeoutMs);

    const cleanup = (): void => {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.off('exit', onExit);
    };
    const onExit = (code: number | null): void => {
      cleanup();
      reject(new Error(`bridge pid ${child.pid} exited before a frame (code ${code})`));
    };
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length < 4) return;
      const len = buffered.readUInt32LE(0);
      if (buffered.length < 4 + len) return;
      cleanup();
      resolve(JSON.parse(buffered.subarray(4, 4 + len).toString('utf8')));
    };

    child.stdout.on('data', onData);
    child.once('exit', onExit);
  });
}

function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs = 2_000,
): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for bridge pid ${child.pid} to exit`));
    }, timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timer);
      child.off('exit', onExit);
    };
    const onExit = (code: number | null): void => {
      cleanup();
      resolve(code);
    };
    child.once('exit', onExit);
  });
}

async function stopBridge(child: ChildProcessWithoutNullStreams | null): Promise<void> {
  if (!child || child.exitCode !== null) return;
  child.stdin.end();
  try {
    await waitForExit(child);
  } catch {
    child.kill('SIGTERM');
    await waitForExit(child).catch(() => undefined);
  }
}

function logOffset(): number {
  try {
    return fs.statSync(LOG_PATH).size;
  } catch {
    return 0;
  }
}

function readLogSince(offset: number): string {
  return fs.readFileSync(LOG_PATH).subarray(offset).toString('utf8');
}

function registeredPid(deviceId: string): number | undefined {
  try {
    const entries = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8')) as Array<{
      deviceId?: string;
      pid?: number;
    }>;
    return entries.find((entry) => entry.deviceId === deviceId)?.pid;
  } catch {
    return undefined;
  }
}

function canConnect(socketPath: string, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    const done = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(timeoutMs, () => done(false));
  });
}

test('a duplicate bridge exits normally without deleting the winning socket', async () => {
  const deviceId = `race-${crypto.randomUUID()}`;
  const socketPath = socketPathFor(deviceId);
  const winner = spawnBridge();
  let duplicate: ChildProcessWithoutNullStreams | null = null;

  try {
    const ready = readOneFrame(winner);
    winner.stdin.write(hello(deviceId));
    expect(await ready).toEqual({ type: 'status', status: 'ready' });
    expect(await canConnect(socketPath)).toBe(true);
    const winnerRegistryPid = registeredPid(deviceId);
    expect(winnerRegistryPid).toBeNumber();

    const offset = logOffset();
    duplicate = spawnBridge();
    duplicate.stdin.write(hello(deviceId));
    const exitCode = await waitForExit(duplicate);
    const logs = readLogSince(offset);

    expect({
      exitCode,
      duplicateShutdown: logs.includes('shutdown: duplicate'),
      uncaughtListenError:
        logs.includes('uncaught: listen EADDRINUSE') || logs.includes('uncaught: listen EEXIST'),
      winnerStillRunning: winner.exitCode === null,
      winnerSocketStillReachable: await canConnect(socketPath),
      winnerStillRegistered: registeredPid(deviceId) === winnerRegistryPid,
    }).toEqual({
      exitCode: 0,
      duplicateShutdown: true,
      uncaughtListenError: false,
      winnerStillRunning: true,
      winnerSocketStillReachable: true,
      winnerStillRegistered: true,
    });
  } finally {
    await stopBridge(duplicate);
    await stopBridge(winner);
  }
});

test('a five-process startup burst leaves one live owner and no uncaught failures', async () => {
  const deviceId = `burst-${crypto.randomUUID()}`;
  const socketPath = socketPathFor(deviceId);
  const bridges = Array.from({ length: 5 }, () => spawnBridge());
  const offset = logOffset();

  try {
    const observations = bridges.map((child) =>
      readOneFrame(child)
        .then((frame) =>
          JSON.stringify(frame) === JSON.stringify({ type: 'status', status: 'ready' })
            ? 'ready'
            : 'unexpected_frame',
        )
        .catch(() => 'exit'),
    );
    for (const child of bridges) child.stdin.write(hello(deviceId));
    const outcomes = await Promise.all(observations);
    const logs = readLogSince(offset);

    expect({
      ready: outcomes.filter((outcome) => outcome === 'ready').length,
      duplicateExits: outcomes.filter((outcome) => outcome === 'exit').length,
      exitedProcesses: bridges.filter((child) => child.exitCode !== null).length,
      duplicateShutdowns: logs.match(/shutdown: duplicate/g)?.length ?? 0,
      uncaughtListenError:
        logs.includes('uncaught: listen EADDRINUSE') || logs.includes('uncaught: listen EEXIST'),
      socketStillReachable: await canConnect(socketPath),
    }).toEqual({
      ready: 1,
      duplicateExits: 4,
      exitedProcesses: 4,
      duplicateShutdowns: 4,
      uncaughtListenError: false,
      socketStillReachable: true,
    });
  } finally {
    await Promise.all(bridges.map((child) => stopBridge(child)));
  }
});

test('a closed native stdout is a normal disconnect, not an uncaught EPIPE', async () => {
  const deviceId = `pipe-${crypto.randomUUID()}`;
  const child = spawnBridge();
  const offset = logOffset();

  try {
    child.stdout.destroy();
    child.stdin.write(hello(deviceId));
    const exitCode = await waitForExit(child);
    const logs = readLogSince(offset);

    expect({
      exitCode,
      normalShutdown: logs.includes('shutdown: stdout_closed'),
      uncaughtEpipe: logs.includes('uncaught: write EPIPE'),
    }).toEqual({
      exitCode: 0,
      normalShutdown: true,
      uncaughtEpipe: false,
    });
  } finally {
    await stopBridge(child);
  }
});
