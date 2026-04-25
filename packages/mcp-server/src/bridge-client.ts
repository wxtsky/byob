import { Agent, request } from 'undici';
import * as crypto from 'node:crypto';
import { resolveBridgeSocket } from './resolve-bridge.js';

let agent: Agent | null = null;

const MAX_BRIDGE_WAIT_MS = 10 * 60 * 1000;

function getAgent(): Agent {
  if (!agent) {
    const r = resolveBridgeSocket();
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

function fireCancelOnAbort(requestId: string, signal: AbortSignal): void {
  if (signal.aborted) {
    void postCancel(requestId);
    return;
  }
  signal.addEventListener('abort', () => void postCancel(requestId), { once: true });
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

export async function bridgePost<T = unknown>(
  route: string,
  body: unknown,
  opts: BridgeCallOptions = {},
): Promise<{ status: number; body: T }> {
  const requestId = opts.requestId ?? crypto.randomUUID();
  if (opts.signal) fireCancelOnAbort(requestId, opts.signal);
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
    return {
      status: 503,
      body: {
        error: 'bridge_not_running',
        message: `Bridge unreachable: ${e instanceof Error ? e.message : String(e)}`,
      } as unknown as T,
    };
  }
}

export async function bridgeGet<T = unknown>(
  route: string,
  opts: BridgeCallOptions = {},
): Promise<{ status: number; body: T }> {
  const requestId = opts.requestId ?? crypto.randomUUID();
  if (opts.signal) fireCancelOnAbort(requestId, opts.signal);
  const sep = route.includes('?') ? '&' : '?';
  const url = `http://localhost${route}${sep}_requestId=${encodeURIComponent(requestId)}`;
  try {
    const { statusCode, body: respBody } = await request(url, {
      dispatcher: getAgent(),
      signal: opts.signal,
    });
    return { status: statusCode, body: parseOrError(await respBody.text()) as T };
  } catch (e) {
    if (opts.signal?.aborted) {
      return {
        status: 499,
        body: { error: 'aborted', message: 'Cancelled by client', aborted: true } as unknown as T,
      };
    }
    return {
      status: 503,
      body: {
        error: 'bridge_not_running',
        message: `Bridge unreachable: ${e instanceof Error ? e.message : String(e)}`,
      } as unknown as T,
    };
  }
}
