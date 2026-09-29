import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type * as http from 'node:http';
import { Routes, routeKey } from '@byob/shared';
import { writeFrameToStdout, startStdinReader } from './native-messaging.js';
import { startIpcServer, type IpcHandlers } from './ipc-server.js';
import { registerBridge, unregisterBridge, socketPathFor } from './bridge-registry.js';
import { BYOB_DIR, LOG_PATH, DOWNLOADS_DIR, EVAL_AUDIT_PATH } from './paths.js';
import { startUploadServer } from './upload-server.js';

let deviceId: string | null = null;
let extensionConnected = false;
const startedAt = Date.now();
let ipc: http.Server | null = null;
let ownsIpcSocket = false;
let ownsRegistryEntry = false;

interface PendingRequest {
  resolve: (data: unknown) => void;
  timer: NodeJS.Timeout;
}
const pending = new Map<string, PendingRequest>();

// Cancel chain: in-flight map keyed by mcpRequestId. End-to-end coverage
// lives in docs/e2e-checklist.md (Cancel section); we skip a unit test here
// because the UNIX-socket harness needs paths.ts injection that's out of scope.
interface InFlight {
  nmId: string;
  abort: AbortController;
}
const inFlight = new Map<string, InFlight>();

function ensureLogDir(): void {
  if (!fs.existsSync(BYOB_DIR)) fs.mkdirSync(BYOB_DIR, { recursive: true, mode: 0o700 });
}

// Log file descriptor cached for the lifetime of the bridge so that hot
// log paths (every NM frame is logged) don't pay open() + close() syscall
// cost on each line. fs.appendFileSync was doing existsSync + open + write
// + close per call. byob doesn't do log rotation, so a long-lived fd is
// safe; shutdown's process.exit closes it implicitly.
let logFd: number | null = null;
function log(line: string): void {
  ensureLogDir();
  if (logFd === null) {
    logFd = fs.openSync(LOG_PATH, 'a', 0o600);
  }
  fs.writeSync(logFd, `[${new Date().toISOString()}] ${line}\n`);
}

/**
 * Send a command to the extension and wait for the matching result frame.
 */
function sendCommand(
  command: string,
  params: unknown,
  timeoutMs: number,
  mcpRequestId: string | null,
): Promise<unknown> {
  if (!extensionConnected) {
    return Promise.resolve({
      error: 'extension_not_connected',
      message: 'Chrome extension is not connected.',
    });
  }
  const nmId = crypto.randomUUID();
  const abort = new AbortController();
  if (mcpRequestId) inFlight.set(mcpRequestId, { nmId, abort });
  return new Promise((resolve) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      pending.delete(nmId);
      if (mcpRequestId) inFlight.delete(mcpRequestId);
    };
    const timer = setTimeout(() => {
      cleanup();
      // Stop the handler too, or it could still act after the caller gave
      // up (e.g. a click stuck behind a JS dialog firing once it's closed).
      if (extensionConnected) writeFrameToStdout({ type: 'cancel', requestId: nmId });
      resolve({
        error: 'timeout',
        message: `Command ${command} timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);
    pending.set(nmId, {
      resolve: (data) => {
        cleanup();
        resolve(data);
      },
      timer,
    });
    abort.signal.addEventListener(
      'abort',
      () => {
        cleanup();
        resolve({ error: 'aborted', message: 'Cancelled by client', aborted: true });
      },
      { once: true },
    );
    writeFrameToStdout({ type: 'command', requestId: nmId, command, params });
  });
}

/**
 * Generic tool route: `{ command, params, timeoutSec? }` is forwarded to the
 * extension handler of the same name. The bridge stays a thin, dumb pipe —
 * tool semantics live in the extension, presentation in the MCP server.
 */
async function callRoute(body: unknown): Promise<{ status: number; body: unknown }> {
  const b = (body ?? {}) as Record<string, unknown>;
  const mcpRequestId = typeof b._requestId === 'string' ? b._requestId : null;
  const command = typeof b.command === 'string' ? b.command : '';
  if (!command) return { status: 400, body: { error: 'invalid_argument', message: 'command is required' } };
  if (command === 'policy') {
    return { status: 403, body: { error: 'invalid_argument', message: 'policy is only available through `byob policy`' } };
  }
  const params = (b.params ?? {}) as Record<string, unknown>;
  // Only a positive, finite timeout counts; the 30 s cushion lets the
  // extension report its own (more specific) timeout first.
  const t = typeof b.timeoutSec === 'number' && Number.isFinite(b.timeoutSec) && b.timeoutSec > 0 ? b.timeoutSec : 60;
  if (command === 'evaluate') auditEval(params);
  const result = (await sendCommand(command, params, t * 1000 + 30_000, mcpRequestId)) as Record<string, unknown>;
  if (typeof result.error === 'string') {
    return { status: result.aborted ? 499 : 502, body: result };
  }
  return { status: 200, body: result };
}

// Keys derived from Routes via routeKey() so a typo on either side fails at
// compile time.
const tools: IpcHandlers['tools'] = {
  [routeKey(Routes.call)]: callRoute,
  [routeKey(Routes.downloadImages)]: downloadImagesRoute,
  [routeKey(Routes.policy)]: async (body: unknown) => {
    const b = (body ?? {}) as Record<string, unknown>;
    // Up to two minutes for the user to answer the confirmation window.
    const result = (await sendCommand('policy', b.params ?? {}, 150_000, null)) as Record<string, unknown>;
    return typeof result.error === 'string' ? { status: 502, body: result } : { status: 200, body: result };
  },
};

async function downloadImagesRoute(body: unknown): Promise<{ status: number; body: unknown }> {
  const params = (body ?? {}) as Record<string, unknown>;
  const mcpRequestId = typeof params._requestId === 'string' ? params._requestId : null;
  const { _requestId: _strip, ...rest } = params;
  void _strip;
  const givenSaveDir = typeof rest.saveDir === 'string' && rest.saveDir ? rest.saveDir : '';
  const saveDir = givenSaveDir || path.join(DOWNLOADS_DIR, String(Date.now()));
  let upload: Awaited<ReturnType<typeof startUploadServer>> | null = null;
  try {
    upload = await startUploadServer(saveDir);
    const timeoutSec = typeof rest.timeoutSec === 'number' ? rest.timeoutSec : 120;
    const enriched = {
      ...rest,
      saveDir,
      uploadEndpoint: upload.endpoint,
      uploadSecret: upload.secret,
    };
    const result = (await sendCommand(
      'downloadImages',
      enriched,
      timeoutSec * 1000 + 60_000,
      mcpRequestId,
    )) as Record<string, unknown>;
    if (typeof result.error === 'string') {
      return { status: result.aborted ? 499 : 502, body: result };
    }
    // Re-attach saveDir at the top level so callers don't have to remember it.
    return { status: 200, body: { saveDir, ...result } };
  } catch (e) {
    return {
      status: 500,
      body: { error: 'unknown', message: e instanceof Error ? e.message : String(e) },
    };
  } finally {
    if (upload) await upload.close();
  }
}

function auditEval(body: unknown): void {
  try {
    const code = (body as { expression?: string })?.expression ?? '';
    const line = `[${new Date().toISOString()}] code=${code.slice(0, 200).replace(/\n/g, '⏎')}\n`;
    fs.appendFileSync(EVAL_AUDIT_PATH, line, { mode: 0o600 });
  } catch {
    // ignore audit log errors
  }
}

function cancelRequest(mcpRequestId: string): void {
  const entry = inFlight.get(mcpRequestId);
  if (!entry) {
    log(`cancel: unknown requestId ${mcpRequestId} (no-op)`);
    return;
  }
  log(`cancel: aborting requestId=${mcpRequestId} nmId=${entry.nmId}`);
  if (extensionConnected) {
    writeFrameToStdout({ type: 'cancel', requestId: entry.nmId });
  }
  entry.abort.abort();
}

async function handleHello(nextDeviceId: string): Promise<void> {
  deviceId = nextDeviceId;
  extensionConnected = true;
  try {
    ipc = await startIpcServer(deviceId, {
      isExtensionConnected: () => extensionConnected,
      getDeviceId: () => deviceId,
      getStartedAt: () => startedAt,
      tools,
      cancel: cancelRequest,
    });
    ownsIpcSocket = true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    const syscall = (error as NodeJS.ErrnoException | undefined)?.syscall;
    if (
      (code === 'EADDRINUSE' || code === 'EEXIST') &&
      (!syscall || syscall === 'listen')
    ) {
      log(`duplicate bridge: ${code} for ${socketPathFor(deviceId)}`);
      await shutdown('duplicate');
      return;
    }
    throw error;
  }
  registerBridge({ deviceId, pid: process.pid, socket: socketPathFor(deviceId) });
  ownsRegistryEntry = true;
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

let shuttingDown = false;
async function shutdown(reason: string): Promise<void> {
  // Re-entry guard: SIGTERM/SIGINT followed by a stop-timeout SIGKILL would
  // re-fire this handler. Without the guard, the second pass races
  // unlinkSync(socket) against a newer bridge that may have already bound
  // the same path.
  if (shuttingDown) return;
  shuttingDown = true;
  const shouldUnlinkSocket = ownsIpcSocket;
  const shouldUnregister = ownsRegistryEntry;
  ownsIpcSocket = false;
  ownsRegistryEntry = false;
  log(`shutdown: ${reason}`);
  extensionConnected = false;
  for (const [, p] of pending) {
    clearTimeout(p.timer);
    p.resolve({ error: 'bridge_not_running', message: 'Bridge is shutting down' });
  }
  pending.clear();
  for (const [, ent] of inFlight) ent.abort.abort();
  inFlight.clear();
  // ipc.close() is async — await it before unlinking the socket so we don't
  // race the close callback against the next bridge spawn that re-binds the
  // same path. cleanupStaleSocket exists as a safety net but should rarely
  // fire after this.
  if (ipc) {
    const ipcRef = ipc;
    ipc = null;
    await new Promise<void>((resolve) => {
      try {
        ipcRef.close(() => resolve());
      } catch {
        resolve();
      }
    });
  }
  if (deviceId && shouldUnlinkSocket) {
    // Windows: socket is a Named Pipe — OS reclaims it on listener close,
    // there's no file to unlink.
    if (process.platform !== 'win32') {
      try {
        fs.unlinkSync(socketPathFor(deviceId));
      } catch {
        // socket already gone
      }
    }
  }
  if (deviceId && shouldUnregister) unregisterBridge(deviceId, process.pid);
  process.exit(0);
}

export function runBridge(): void {
  // umask is meaningless on Windows (NTFS uses ACLs not POSIX bits);
  // mirrors the install.ts guard so behavior is consistent across entry
  // points. Calling umask on Windows is a no-op in current Node but
  // emits a deprecation warning in some builds.
  if (process.platform !== 'win32') process.umask(0o077);
  ensureLogDir();
  log(`bridge started, pid=${process.pid}`);

  // Native Messaging stdout belongs to Chrome. Closing the port tears down
  // the pipe, and the next write reports EPIPE asynchronously as a stream
  // `error` event (a try/catch around stdout.write cannot catch it).
  process.stdout.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE' || error.code === 'ERR_STREAM_DESTROYED') {
      void shutdown('stdout_closed');
      return;
    }
    log(`stdout error: ${error.message}\n${error.stack ?? ''}`);
    void shutdown('stdout_error');
  });

  startStdinReader((msg) => {
    if (!msg || typeof msg !== 'object') return;
    const m = msg as Record<string, unknown>;
    log(`<- ${JSON.stringify(m).slice(0, 300)}`);
    if (m.type === 'hello' && typeof m.deviceId === 'string') {
      void handleHello(m.deviceId).catch((e: unknown) => {
        log(`handleHello error: ${e}`);
        void shutdown('hello_error');
      });
    } else if (m.type === 'result' && typeof m.requestId === 'string') {
      handleResult(m.requestId, m);
    }
  });

  process.stdin.on('end', () => void shutdown('stdin_end'));
  process.stdin.on('close', () => void shutdown('stdin_close'));
  process.on('SIGTERM', () => void shutdown('sigterm'));
  process.on('SIGINT', () => void shutdown('sigint'));
  process.on('uncaughtException', (e: Error) => {
    log(`uncaught: ${e.message}\n${e.stack ?? ''}`);
    void shutdown('uncaught');
  });
}
