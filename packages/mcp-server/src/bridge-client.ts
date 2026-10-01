import { Agent, request } from 'undici';
import * as crypto from 'node:crypto';
import { BRIDGE_LOG, resolveBridge, type BridgeInfo } from './resolve-bridge.js';
import { resetState } from './state.js';
import { VERSION } from './server.js';

let agent: Agent | null = null;
let agentSocket: string | null = null;
/** deviceId:pid:startedAt of the bridge we last talked to. */
let bridgeKey: string | null = null;
/** Compare versions once per bridge identity (see bridgeNotice). */
let versionCheckPending = false;

const MAX_BRIDGE_WAIT_MS = 10 * 60 * 1000;

/**
 * Resolve the live bridge and notice when it is a different one than last
 * time — Chrome (or the extension) restarted. Chrome tab IDs are only
 * unique within one browser run, so the remembered working / owned tabs
 * are dropped before any of them can be injected into a call. Throws a
 * BridgeResolveError (code + hint) when no bridge can be picked.
 */
export function ensureBridge(): BridgeInfo {
  const r = resolveBridge();
  const key = `${r.deviceId}:${r.pid}:${r.startedAt}`;
  if (key !== bridgeKey) {
    if (bridgeKey !== null) resetState();
    bridgeKey = key;
    versionCheckPending = true;
  }
  return r;
}

function getAgent(): Agent {
  const r = ensureBridge();
  if (!agent || agentSocket !== r.socket) {
    agent?.close();
    agentSocket = r.socket;
    agent = new Agent({
      connect: { socketPath: r.socket },
      headersTimeout: MAX_BRIDGE_WAIT_MS,
      bodyTimeout: MAX_BRIDGE_WAIT_MS,
    });
  }
  return agent;
}

function parseOrError(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { error: 'unknown', message: `Non-JSON from bridge: ${text.slice(0, 200)}` };
  }
}

export interface BridgeCallOptions {
  /** Forwarded as `_requestId` body field; bridge uses it as in-flight map key. */
  requestId?: string;
  /** When this aborts, the in-flight HTTP request is dropped *and* a /cancel POST is fired. */
  signal?: AbortSignal;
}

/**
 * Wire up cancel-on-abort and return a disposer the caller MUST run in a
 * `finally`. Without the disposer, every bridgePost would leak one abort
 * listener onto the MCP request signal, which the SDK reuses across the
 * whole client connection in some implementations.
 */
function fireCancelOnAbort(requestId: string, signal: AbortSignal): () => void {
  if (signal.aborted) {
    void postCancel(requestId);
    return () => {};
  }
  const onAbort = (): void => void postCancel(requestId);
  signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener('abort', onAbort);
}

async function postCancel(requestId: string): Promise<void> {
  try {
    await request('http://localhost/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId }),
      dispatcher: getAgent(),
    });
  } catch {
    // Bridge may already be down or unreachable; best-effort.
  }
}

/** Socket-level failures: the registry names a live bridge we can't reach. */
const UNREACHABLE = /ECONNREFUSED|ENOENT|ECONNRESET|EPIPE|socket hang up|other side closed/i;

function unreachable(e: unknown): Record<string, unknown> {
  const x = e as { code?: unknown; hint?: unknown; message?: unknown; cause?: { code?: unknown; message?: unknown } };
  // resolveBridge explains itself (not set up / browser closed / ambiguous).
  if (x?.code === 'bridge_not_running' && typeof x.hint === 'string') {
    return { error: 'bridge_not_running', message: String(x.message), hint: x.hint };
  }
  const detail = [x?.code, x?.cause?.code, x?.message, x?.cause?.message].filter((v) => typeof v === 'string').join(' ');
  if (UNREACHABLE.test(detail)) {
    return {
      error: 'bridge_not_running',
      message: `The byob bridge isn't answering (${detail.trim()}) — it probably crashed.`,
      hint: `Ask the user to reload the byob extension in chrome://extensions; the cause is in ${BRIDGE_LOG}.`,
    };
  }
  return { error: 'bridge_not_running', message: `Bridge unreachable: ${e instanceof Error ? e.message : String(e)}` };
}

export async function bridgePost<T = unknown>(
  route: string,
  body: unknown,
  opts: BridgeCallOptions = {},
): Promise<{ status: number; body: T }> {
  const requestId = opts.requestId ?? crypto.randomUUID();
  const dispose = opts.signal ? fireCancelOnAbort(requestId, opts.signal) : () => {};
  const enrichedBody = { ...((body as Record<string, unknown>) ?? {}), _requestId: requestId };
  try {
    const { statusCode, body: respBody } = await request(`http://localhost${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(enrichedBody),
      dispatcher: getAgent(),
      signal: opts.signal,
    });
    return { status: statusCode, body: parseOrError(await respBody.text()) as T };
  } catch (e) {
    if (opts.signal?.aborted) {
      return {
        status: 499,
        body: {
          error: 'aborted',
          message: 'Cancelled by client',
          aborted: true,
        } as unknown as T,
      };
    }
    return { status: 503, body: unreachable(e) as T };
  } finally {
    dispose();
  }
}

export const RELOAD_HINT = 'reload the byob extension in chrome://extensions';

/**
 * A one-time warning when the connected extension is not the version of
 * this MCP server (typical right after an upgrade: the plugin updated, the
 * extension wasn't reloaded). Checked once per bridge identity; null when
 * there's nothing to say or the bridge can't be asked.
 */
export async function bridgeNotice(): Promise<string | null> {
  if (!versionCheckPending || !agent) return null;
  versionCheckPending = false;
  try {
    const { statusCode, body } = await request('http://localhost/status', {
      dispatcher: agent,
      signal: AbortSignal.timeout(2000),
    });
    const s = parseOrError(await body.text()) as { extensionVersion?: unknown };
    if (statusCode >= 400) return null;
    const ext = typeof s.extensionVersion === 'string' ? s.extensionVersion : null;
    if (ext === VERSION) return null;
    return ext
      ? `⚠ byob extension v${ext} ≠ MCP server v${VERSION} — ${RELOAD_HINT}.`
      : `⚠ the byob extension or bridge is older than this MCP server (v${VERSION}) — ${RELOAD_HINT}.`;
  } catch {
    versionCheckPending = true; // try again on the next call
    return null;
  }
}
