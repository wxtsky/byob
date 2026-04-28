const NATIVE_HOST = 'ai.byob.bridge';

export type IncomingMessage =
  | { type: 'status'; status: 'ready' }
  | { type: 'command'; requestId: string; command: string; params: unknown }
  | { type: 'cancel'; requestId: string };

export interface NativeBus {
  post(msg: unknown): void;
  isConnected(): boolean;
}

let port: chrome.runtime.Port | null = null;
let backoffMs = 1000;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let onMessageCb: ((msg: IncomingMessage) => void) | null = null;
let onReadyCb: (() => void | Promise<void>) | null = null;

async function getDeviceId(): Promise<string> {
  const stored = (await chrome.storage.local.get('deviceId')) as { deviceId?: string };
  if (stored.deviceId) return stored.deviceId;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ deviceId: id });
  return id;
}

export const bus: NativeBus = {
  post(msg: unknown): void {
    if (!port) throw new Error('NM port not connected');
    port.postMessage(msg);
  },
  isConnected(): boolean {
    return port !== null;
  },
};

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
    backoffMs = Math.min(backoffMs * 2, 30_000);
  }, backoffMs);
}

function connect(): void {
  if (port) return;
  let p: chrome.runtime.Port;
  try {
    p = chrome.runtime.connectNative(NATIVE_HOST);
  } catch (e) {
    console.warn('[byob] connectNative threw:', e);
    scheduleReconnect();
    return;
  }
  port = p;

  p.onMessage.addListener((msg: IncomingMessage) => {
    backoffMs = 1000;
    if (msg && typeof msg === 'object' && msg.type === 'status' && msg.status === 'ready') {
      void onReadyCb?.();
      return;
    }
    if (onMessageCb) onMessageCb(msg);
  });

  p.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError;
    console.warn('[byob] NM disconnected:', err?.message);
    port = null;
    if (err?.message?.includes('not found') || err?.message?.includes('not installed')) {
      // Bridge not installed; don't busy-loop reconnecting.
      return;
    }
    scheduleReconnect();
  });

  void getDeviceId()
    .then((deviceId) => {
      // Port may have disconnected while we awaited chrome.storage. The
      // onDisconnect listener nulls `port` in that case; postMessage on
      // the captured `p` would then throw "Attempting to use a
      // disconnected port object". Guard against both the racing
      // disconnect and the moment-zero throw.
      if (port !== p) return;
      try {
        p.postMessage({ type: 'hello', deviceId });
      } catch {
        // race: disconnect fired between the check and postMessage.
      }
    })
    .catch((e: unknown) => {
      console.warn('[byob] hello dispatch failed:', e);
    });
}

export function startNativeBus(opts: {
  onMessage: (msg: IncomingMessage) => void;
  onReady?: () => void | Promise<void>;
}): void {
  onMessageCb = opts.onMessage;
  onReadyCb = opts.onReady ?? null;
  connect();
}
