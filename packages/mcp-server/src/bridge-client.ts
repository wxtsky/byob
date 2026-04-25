import { Agent, request } from 'undici';
import { resolveBridgeSocket } from './resolve-bridge.js';

let agent: Agent | null = null;

function getAgent(): Agent {
  if (!agent) {
    const r = resolveBridgeSocket();
    agent = new Agent({ connect: { socketPath: r.socket } });
  }
  return agent;
}

export async function bridgePost<T = unknown>(
  route: string,
  body: unknown,
): Promise<{ status: number; body: T }> {
  const a = getAgent();
  const { statusCode, body: respBody } = await request(`http://localhost${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    dispatcher: a,
  });
  const text = await respBody.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { error: 'unknown', message: `Non-JSON from bridge: ${text.slice(0, 200)}` };
  }
  return { status: statusCode, body: parsed as T };
}

export async function bridgeGet<T = unknown>(
  route: string,
): Promise<{ status: number; body: T }> {
  const a = getAgent();
  const { statusCode, body: respBody } = await request(`http://localhost${route}`, {
    dispatcher: a,
  });
  const text = await respBody.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { error: 'unknown', message: `Non-JSON from bridge: ${text.slice(0, 200)}` };
  }
  return { status: statusCode, body: parsed as T };
}
