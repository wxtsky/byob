import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type * as http from 'node:http';
import { Routes, routeKey } from '@byob/shared';
import { writeFrameToStdout, startStdinReader } from './native-messaging.js';
import { startIpcServer, type IpcHandlers } from './ipc-server.js';
import { registerBridge, unregisterBridge, socketPathFor } from './bridge-registry.js';
import { BYOB_DIR, LOG_PATH, SCREENSHOTS_DIR, DOWNLOADS_DIR, PDFS_DIR, EVAL_AUDIT_PATH } from './paths.js';
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
    // Only honor a positive, finite timeoutSec — `0` and negatives both
    // fall back to defaultTimeoutSec, since "0 seconds" + 30s buffer is
    // never what callers want (they'd just time out immediately under any
    // load) and used to silently produce a 30s hard timeout regardless.
    const timeoutSecRaw = typeof b.timeoutSec === 'number' ? Number(b.timeoutSec) : NaN;
    const timeoutSec =
      Number.isFinite(timeoutSecRaw) && timeoutSecRaw > 0 ? timeoutSecRaw : defaultTimeoutSec;
    const timeoutMs = timeoutSec * 1000 + 30_000;
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
  } else {
    // User-supplied path: ensure parent dir exists so that callers don't have to
    // mkdir -p themselves before every screenshot. Mirrors the no-savePath branch.
    fs.mkdirSync(path.dirname(savePath), { recursive: true });
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

// Memory: extension joins base64 chunks into one string, then NM ships it to
// us, then Buffer.from() decodes — for a 100MB PDF that's ~3 copies in flight.
// Acceptable for typical pages; very large docs should use pageRanges.
async function printPdfRoute(body: unknown): Promise<{ status: number; body: unknown }> {
  const b = (body ?? {}) as Record<string, unknown>;
  const mcpRequestId = typeof b._requestId === 'string' ? b._requestId : null;
  const { _requestId: _strip, ...handlerParams } = b;
  void _strip;
  // PDF generation can take a while for big pages; mirror screenshot's 60s.
  const result = (await sendCommand('printPdf', handlerParams, 120_000, mcpRequestId)) as Record<
    string,
    unknown
  >;
  if (typeof result.error === 'string') {
    return { status: result.aborted ? 499 : 502, body: result };
  }

  const data = typeof result._b64Data === 'string' ? result._b64Data : '';
  if (!data) {
    return {
      status: 502,
      body: { error: 'unknown', message: 'Extension returned empty PDF data' },
    };
  }
  let savePath = (result._savePath as string) ?? '';
  if (!savePath) {
    fs.mkdirSync(PDFS_DIR, { recursive: true, mode: 0o700 });
    savePath = path.join(PDFS_DIR, `${Date.now()}.pdf`);
  } else {
    // Allow user-given path; ensure parent dir exists.
    fs.mkdirSync(path.dirname(savePath), { recursive: true, mode: 0o700 });
  }
  try {
    fs.writeFileSync(savePath, Buffer.from(data, 'base64'), { mode: 0o600 });
  } catch (e) {
    return {
      status: 500,
      body: { error: 'unknown', message: e instanceof Error ? e.message : String(e) },
    };
  }
  const byteLength = Buffer.byteLength(data, 'base64');
  return {
    status: 200,
    body: {
      path: savePath,
      byteLength,
      tabId: result.tabId ?? 0,
      url: result.url ?? '',
    },
  };
}

async function uploadFileRoute(body: unknown): Promise<{ status: number; body: unknown }> {
  const b = (body ?? {}) as Record<string, unknown>;
  const mcpRequestId = typeof b._requestId === 'string' ? b._requestId : null;
  const { _requestId: _strip, ...handlerParams } = b;
  void _strip;

  const paths = Array.isArray(handlerParams.paths)
    ? (handlerParams.paths as unknown[]).filter((p): p is string => typeof p === 'string')
    : [];
  if (paths.length === 0) {
    return {
      status: 400,
      body: { error: 'file_not_found', message: 'paths must be a non-empty string array' },
    };
  }

  // Validate every path: absolute + readable.
  const meta: { path: string; name: string; size: number }[] = [];
  for (const p of paths) {
    if (!path.isAbsolute(p)) {
      return {
        status: 400,
        body: { error: 'file_not_found', message: `path is not absolute: ${p}` },
      };
    }
    let stat: fs.Stats;
    try {
      fs.accessSync(p, fs.constants.R_OK);
      stat = fs.statSync(p);
    } catch {
      return {
        status: 400,
        body: { error: 'file_not_found', message: `file not readable: ${p}` },
      };
    }
    meta.push({ path: p, name: path.basename(p), size: stat.size });
  }

  const result = (await sendCommand('uploadFile', handlerParams, 60_000, mcpRequestId)) as Record<
    string,
    unknown
  >;
  if (typeof result.error === 'string') {
    return { status: result.aborted ? 499 : 502, body: result };
  }
  return {
    status: 200,
    body: {
      tabId: result.tabId ?? 0,
      url: result.url ?? '',
      files: meta,
    },
  };
}

// Keys derived from Routes via routeKey() so a typo on either side fails
// at compile time — no more hand-maintained string parity with bridge-client.
const tools: IpcHandlers['tools'] = {
  [routeKey(Routes.read)]:       routeFor('readPage'),
  [routeKey(Routes.click)]:      routeFor('click', 30),
  [routeKey(Routes.type)]:       routeFor('type', 30),
  [routeKey(Routes.navigate)]:   routeFor('navigate', 60),
  [routeKey(Routes.waitFor)]:    routeFor('waitFor', 30),
  [routeKey(Routes.screenshot)]: screenshotRoute,
  [routeKey(Routes.cookies)]:    routeFor('getCookies', 10),
  [routeKey(Routes.listTabs)]:   routeFor('listTabs', 5),
  [routeKey(Routes.switchTab)]:  routeFor('switchTab', 5),
  [routeKey(Routes.eval)]: async (body: unknown) => {
    auditEval(body);
    return routeFor('eval', 30)(body);
  },
  [routeKey(Routes.downloadImages)]:  downloadImagesRoute,
  [routeKey(Routes.getConsoleLogs)]:  routeFor('getConsoleLogs', 30),
  [routeKey(Routes.readMarkdown)]:    readMarkdownRoute,
  [routeKey(Routes.extractTable)]:    routeFor('extractTable', 30),
  // start returns immediately after attaching CDP — 10 s is plenty.
  [routeKey(Routes.recordNetworkStart)]: routeFor('startRecordNetwork', 10),
  // stop must absorb flushDelayMs (default 500 ms, max 30 s) plus any in-flight
  // response-body fetches the listener may still be awaiting. 300 s upper bound
  // matches the largest realistic recording window we're willing to drain.
  [routeKey(Routes.recordNetworkStop)]:  routeFor('stopRecordNetwork', 300),
  // v0.3 Batch 1
  [routeKey(Routes.scroll)]:     routeFor('scroll', 30),
  [routeKey(Routes.pressKey)]:   routeFor('pressKey', 30),
  [routeKey(Routes.select)]:     routeFor('select', 30),
  [routeKey(Routes.closeTab)]:   routeFor('closeTab', 5),
  [routeKey(Routes.goBack)]:     routeFor('goBack', 60),
  [routeKey(Routes.goForward)]:  routeFor('goForward', 60),
  [routeKey(Routes.hover)]:      routeFor('hover', 30),
  [routeKey(Routes.getHtml)]:    routeFor('getHtml', 30),
  // v0.3 Batch 2
  [routeKey(Routes.setCookies)]:     routeFor('setCookies', 10),
  [routeKey(Routes.printPdf)]:       printPdfRoute,
  [routeKey(Routes.getStorage)]:     routeFor('getStorage', 30),
  [routeKey(Routes.getPerformance)]: routeFor('getPerformance', 60),
  [routeKey(Routes.uploadFile)]:     uploadFileRoute,
  // v0.3 Batch 3
  [routeKey(Routes.interceptStart)]: routeFor('interceptStart', 30),
  [routeKey(Routes.interceptStop)]:  routeFor('interceptStop', 10),
  [routeKey(Routes.drag)]:           routeFor('drag', 60),
  [routeKey(Routes.emulateDevice)]:  routeFor('emulateDevice', 30),
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

let shuttingDown = false;
async function shutdown(reason: string): Promise<void> {
  // Re-entry guard: SIGTERM/SIGINT followed by a stop-timeout SIGKILL would
  // re-fire this handler. Without the guard, the second pass races
  // unlinkSync(socket) against a newer bridge that may have already bound
  // the same path.
  if (shuttingDown) return;
  shuttingDown = true;
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

  process.stdin.on('end', () => void shutdown('stdin_end'));
  process.stdin.on('close', () => void shutdown('stdin_close'));
  process.on('SIGTERM', () => void shutdown('sigterm'));
  process.on('SIGINT', () => void shutdown('sigint'));
  process.on('uncaughtException', (e: Error) => {
    log(`uncaught: ${e.message}\n${e.stack ?? ''}`);
    void shutdown('uncaught');
  });
}
