import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type * as http from 'node:http';
import { writeFrameToStdout, startStdinReader } from './native-messaging.js';
import { startIpcServer, type IpcHandlers } from './ipc-server.js';
import { registerBridge, unregisterBridge, socketPathFor } from './bridge-registry.js';
import { BYOB_DIR, LOG_PATH, SCREENSHOTS_DIR, DOWNLOADS_DIR, EVAL_AUDIT_PATH } from './paths.js';
import { startUploadServer } from './upload-server.js';

let deviceId: string | null = null;
let extensionConnected = false;
const startedAt = Date.now();
let ipc: http.Server | null = null;

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
function log(line: string): void {
  ensureLogDir();
  fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${line}\n`, { mode: 0o600 });
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
 * Wrap sendCommand into an HTTP route handler shape.
 * Default timeout is 60s; per-request `timeoutSec` in body overrides.
 */
function routeFor(command: string, defaultTimeoutSec = 60) {
  return async (body: unknown): Promise<{ status: number; body: unknown }> => {
    const b = (body ?? {}) as Record<string, unknown>;
    const mcpRequestId = typeof b._requestId === 'string' ? b._requestId : null;
    const timeoutSec =
      typeof b.timeoutSec === 'number' ? Number(b.timeoutSec) : NaN;
    const timeoutMs = (Number.isFinite(timeoutSec) ? timeoutSec : defaultTimeoutSec) * 1000 + 30_000;
    const { _requestId: _strip, ...handlerParams } = b;
    void _strip;
    const result = (await sendCommand(command, handlerParams, timeoutMs, mcpRequestId)) as Record<
      string,
      unknown
    >;
    if (typeof result.error === 'string') {
      return { status: result.aborted ? 499 : 502, body: result };
    }
    return { status: 200, body: result };
  };
}

async function screenshotRoute(body: unknown): Promise<{ status: number; body: unknown }> {
  // Forward to extension as 'screenshot' command, then post-process the b64.
  const b = (body ?? {}) as Record<string, unknown>;
  const mcpRequestId = typeof b._requestId === 'string' ? b._requestId : null;
  const { _requestId: _strip, ...handlerParams } = b;
  void _strip;
  const result = (await sendCommand('screenshot', handlerParams, 60_000, mcpRequestId)) as Record<
    string,
    unknown
  >;
  if (typeof result.error === 'string') {
    return { status: result.aborted ? 499 : 502, body: result };
  }

  const data = typeof result._b64Data === 'string' ? result._b64Data : '';
  const format = (result._format as string) ?? 'png';
  const ext = format === 'jpeg' ? 'jpg' : 'png';
  let savePath = (result._savePath as string) ?? '';
  if (!savePath) {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true, mode: 0o700 });
    savePath = path.join(SCREENSHOTS_DIR, `${Date.now()}.${ext}`);
  }
  try {
    fs.writeFileSync(savePath, Buffer.from(data, 'base64'), { mode: 0o600 });
  } catch (e) {
    return {
      status: 500,
      body: { error: 'unknown', message: e instanceof Error ? e.message : String(e) },
    };
  }

  return {
    status: 200,
    body: {
      path: savePath,
      width: result.width ?? 0,
      height: result.height ?? 0,
      format,
    },
  };
}

const tools: IpcHandlers['tools'] = {
  read:       routeFor('readPage'),
  click:      routeFor('click', 30),
  type:       routeFor('type', 30),
  navigate:   routeFor('navigate', 60),
  'wait-for': routeFor('waitFor', 30),
  screenshot: screenshotRoute,
  cookies:        routeFor('getCookies', 10),
  '__list-tabs':  routeFor('listTabs', 5),
  'tabs/switch':  routeFor('switchTab', 5),
  eval: async (body: unknown) => {
    auditEval(body);
    return routeFor('eval', 30)(body);
  },
  'download-images': downloadImagesRoute,
  'get-console-logs': routeFor('getConsoleLogs', 30),
  'read-markdown':    readMarkdownRoute,
  'extract-table':    routeFor('extractTable', 30),
  // start returns immediately after attaching CDP — 10 s is plenty.
  'record-network/start': routeFor('startRecordNetwork', 10),
  // stop must absorb flushDelayMs (default 500 ms, max 30 s) plus any in-flight
  // response-body fetches the listener may still be awaiting. 300 s upper bound
  // matches the largest realistic recording window we're willing to drain.
  'record-network/stop':  routeFor('stopRecordNetwork', 300),
  // v0.3 Batch 1
  scroll:        routeFor('scroll', 30),
  'press-key':   routeFor('pressKey', 30),
  select:        routeFor('select', 30),
  'close-tab':   routeFor('closeTab', 5),
  'go-back':     routeFor('goBack', 60),
  'go-forward':  routeFor('goForward', 60),
  hover:         routeFor('hover', 30),
  'get-html':    routeFor('getHtml', 30),
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

async function readMarkdownRoute(body: unknown): Promise<{ status: number; body: unknown }> {
  const params = (body ?? {}) as Record<string, unknown>;
  const mcpRequestId = typeof params._requestId === 'string' ? params._requestId : null;
  const { _requestId: _strip, ...rest } = params;
  void _strip;
  // /readability uses a temp dir only because startUploadServer mkdir's it
  // up-front for download-images. We point it at a unique throwaway path so
  // we never accidentally touch real downloads.
  const scratchDir = path.join(DOWNLOADS_DIR, '.readability-' + Date.now());
  let upload: Awaited<ReturnType<typeof startUploadServer>> | null = null;
  try {
    upload = await startUploadServer(scratchDir);
    const timeoutSec = typeof rest.timeoutSec === 'number' ? rest.timeoutSec : 60;
    const enriched = {
      ...rest,
      // Extension reads these two and POSTs HTML to readabilityEndpoint.
      readabilityEndpoint: upload.readabilityEndpoint,
      readabilitySecret: upload.secret,
    };
    const result = (await sendCommand(
      'readMarkdown',
      enriched,
      timeoutSec * 1000 + 60_000,
      mcpRequestId,
    )) as Record<string, unknown>;
    if (typeof result.error === 'string') {
      return { status: result.aborted ? 499 : 502, body: result };
    }
    return { status: 200, body: result };
  } catch (e) {
    return {
      status: 500,
      body: { error: 'unknown', message: e instanceof Error ? e.message : String(e) },
    };
  } finally {
    if (upload) await upload.close();
    // Clean up the empty scratch dir if no /upload calls landed in it.
    try {
      const entries = fs.readdirSync(scratchDir);
      if (entries.length === 0) fs.rmdirSync(scratchDir);
    } catch {
      // ignore: dir may already be gone or non-empty
    }
  }
}

function auditEval(body: unknown): void {
  try {
    const code = (body as { code?: string })?.code ?? '';
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
  ipc = await startIpcServer(deviceId, {
    isExtensionConnected: () => extensionConnected,
    getDeviceId: () => deviceId,
    getStartedAt: () => startedAt,
    tools,
    cancel: cancelRequest,
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
  for (const [, ent] of inFlight) ent.abort.abort();
  inFlight.clear();
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
