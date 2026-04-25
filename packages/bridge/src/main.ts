import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import type * as http from 'node:http';
import { writeFrameToStdout, startStdinReader } from './native-messaging.js';
import { startIpcServer, type IpcHandlers } from './ipc-server.js';
import { registerBridge, unregisterBridge, socketPathFor } from './bridge-registry.js';
import { DOKO_DIR, LOG_PATH } from './paths.js';

let deviceId: string | null = null;
let extensionConnected = false;
const startedAt = Date.now();
let ipc: http.Server | null = null;

interface PendingRequest {
  resolve: (data: unknown) => void;
  timer: NodeJS.Timeout;
}
const pending = new Map<string, PendingRequest>();

function ensureLogDir(): void {
  if (!fs.existsSync(DOKO_DIR)) fs.mkdirSync(DOKO_DIR, { recursive: true, mode: 0o700 });
}
function log(line: string): void {
  ensureLogDir();
  fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${line}\n`, { mode: 0o600 });
}

/**
 * Send a command to the extension and wait for the matching result frame.
 */
function sendCommand(command: string, params: unknown, timeoutMs: number): Promise<unknown> {
  if (!extensionConnected) {
    return Promise.resolve({
      error: 'extension_not_connected',
      message: 'Chrome extension is not connected.',
    });
  }
  const requestId = crypto.randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      resolve({
        error: 'timeout',
        message: `Command ${command} timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);
    pending.set(requestId, { resolve, timer });
    writeFrameToStdout({ type: 'command', requestId, command, params });
  });
}

/**
 * Wrap sendCommand into an HTTP route handler shape.
 * Default timeout is 60s; per-request `timeoutSec` in body overrides.
 */
function routeFor(command: string, defaultTimeoutSec = 60) {
  return async (body: unknown): Promise<{ status: number; body: unknown }> => {
    const timeoutSec =
      typeof body === 'object' && body && 'timeoutSec' in body
        ? Number((body as { timeoutSec: unknown }).timeoutSec)
        : NaN;
    const timeoutMs = (Number.isFinite(timeoutSec) ? timeoutSec : defaultTimeoutSec) * 1000 + 30_000;
    const result = (await sendCommand(command, body, timeoutMs)) as Record<string, unknown>;
    if (
      result &&
      typeof result === 'object' &&
      'error' in result &&
      typeof result.error === 'string'
    ) {
      return { status: 502, body: result };
    }
    return { status: 200, body: result };
  };
}

const tools: IpcHandlers['tools'] = {
  read: routeFor('readPage'),
};

async function handleHello(nextDeviceId: string): Promise<void> {
  deviceId = nextDeviceId;
  extensionConnected = true;
  ipc = await startIpcServer(deviceId, {
    isExtensionConnected: () => extensionConnected,
    getDeviceId: () => deviceId,
    getStartedAt: () => startedAt,
    tools,
  });
  registerBridge({ deviceId, pid: process.pid, socket: socketPathFor(deviceId) });
  writeFrameToStdout({ type: 'status', status: 'ready' });
  log(`hello received, deviceId=${deviceId}, IPC up at ${socketPathFor(deviceId)}`);
}

function handleResult(requestId: string, result: Record<string, unknown>): void {
  const p = pending.get(requestId);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(requestId);
  // Strip NM-protocol envelope fields so HTTP API only exposes the handler's
  // own payload (data fields or {error, message, hint, aborted}).
  const { type: _t, requestId: _r, ...payload } = result;
  void _t;
  void _r;
  p.resolve(payload);
}

function shutdown(reason: string): void {
  log(`shutdown: ${reason}`);
  extensionConnected = false;
  for (const [, p] of pending) {
    clearTimeout(p.timer);
    p.resolve({ error: 'bridge_not_running', message: 'Bridge is shutting down' });
  }
  pending.clear();
  if (ipc) {
    ipc.close();
    ipc = null;
  }
  if (deviceId) {
    try {
      fs.unlinkSync(socketPathFor(deviceId));
    } catch {
      // socket already gone
    }
    unregisterBridge(deviceId);
  }
  process.exit(0);
}

export function runBridge(): void {
  process.umask(0o077);
  ensureLogDir();
  log(`bridge started, pid=${process.pid}`);

  startStdinReader((msg) => {
    if (!msg || typeof msg !== 'object') return;
    const m = msg as Record<string, unknown>;
    log(`<- ${JSON.stringify(m).slice(0, 300)}`);
    if (m.type === 'hello' && typeof m.deviceId === 'string') {
      void handleHello(m.deviceId).catch((e: unknown) => log(`handleHello error: ${e}`));
    } else if (m.type === 'result' && typeof m.requestId === 'string') {
      handleResult(m.requestId, m);
    }
  });

  process.stdin.on('end', () => shutdown('stdin_end'));
  process.stdin.on('close', () => shutdown('stdin_close'));
  process.on('SIGTERM', () => shutdown('sigterm'));
  process.on('SIGINT', () => shutdown('sigint'));
  process.on('uncaughtException', (e: Error) => {
    log(`uncaught: ${e.message}\n${e.stack ?? ''}`);
    shutdown('uncaught');
  });
}
