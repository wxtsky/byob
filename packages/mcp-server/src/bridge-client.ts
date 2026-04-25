import { Agent, request } from 'undici';
import { resolveBridgeSocket } from './resolve-bridge.js';

let agent: Agent | null = null;

// Cap how long mcp-server will wait on a single bridge HTTP exchange. Bridge
// itself enforces per-tool deadlines (timeoutSec * 1000 + 30_000), so this
// value just needs to be a safe upper bound that prevents a hung bridge from
// stalling the MCP client forever. 10 minutes covers even fullPage screenshots
// + max-screen reads with comfortable margin.
const MAX_BRIDGE_WAIT_MS = 10 * 60 * 1000;

function getAgent(): Agent {
  if (!agent) {
    const r = resolveBridgeSocket();
    agent = new Agent({
      connect: { socketPath: r.socket },
      // Cover both the request headers + body wait phases — undici's defaults
      // are generous (5 min headers, 5 min body) but explicit is clearer.
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

export async function bridgePost<T = unknown>(
  route: string,
  body: unknown,
): Promise<{ status: number; body: T }> {
  try {
    const { statusCode, body: respBody } = await request(`http://localhost${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      dispatcher: getAgent(),
    });
    return { status: statusCode, body: parseOrError(await respBody.text()) as T };
  } catch (e) {
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
): Promise<{ status: number; body: T }> {
  try {
    const { statusCode, body: respBody } = await request(`http://localhost${route}`, {
      dispatcher: getAgent(),
    });
    return { status: statusCode, body: parseOrError(await respBody.text()) as T };
  } catch (e) {
    return {
      status: 503,
      body: {
        error: 'bridge_not_running',
        message: `Bridge unreachable: ${e instanceof Error ? e.message : String(e)}`,
      } as unknown as T,
    };
  }
}
