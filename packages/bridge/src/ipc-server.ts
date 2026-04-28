import * as http from 'node:http';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { Routes, GetRoutes, routeKey } from '@byob/shared';
import { socketPathFor, BRIDGES_DIR } from './paths.js';

export interface IpcHandlers {
  isExtensionConnected: () => boolean;
  getDeviceId: () => string | null;
  getStartedAt: () => number;
  /** POST routes for tool calls. */
  tools: Record<string, (body: unknown) => Promise<{ status: number; body: unknown }>>;
  /** Called when mcp-server POSTs /cancel { requestId } or when an in-flight HTTP request socket closes. */
  cancel: (requestId: string) => void;
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Uint8Array) => chunks.push(Buffer.from(c)));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function cleanupStaleSocket(sock: string): Promise<void> {
  if (!fs.existsSync(sock)) return;
  await new Promise<void>((resolve) => {
    const c = net.createConnection(sock);
    c.on('connect', () => {
      c.destroy();
      resolve();
    });
    c.on('error', () => {
      try {
        fs.unlinkSync(sock);
      } catch {
        // ignore
      }
      resolve();
    });
  });
}

export async function startIpcServer(deviceId: string, handlers: IpcHandlers): Promise<http.Server> {
  const sock = socketPathFor(deviceId);
  fs.mkdirSync(path.dirname(sock), { recursive: true, mode: 0o700 });
  await cleanupStaleSocket(sock);

  const server = http.createServer((req, res) => {
    void (async () => {
      res.setHeader('Cache-Control', 'no-store');
      try {
        // Match GET routes by pathname only — bridgeGet appends ?_requestId=...
        // for cancel chain parity, so a strict req.url comparison would 404.
        const getPath = req.method === 'GET' && req.url ? req.url.split('?')[0] : null;
        // GET /status
        if (getPath === GetRoutes.status) {
          return send(res, 200, {
            connected: handlers.isExtensionConnected(),
            deviceId: handlers.getDeviceId(),
            sinceMs: Date.now() - handlers.getStartedAt(),
          });
        }
        // GET /tabs — alias of POST /__list-tabs (no body needed).
        if (getPath === GetRoutes.listTabs) {
          const handler = handlers.tools[routeKey(Routes.listTabs)];
          if (handler) {
            const { status, body: out } = await handler(undefined);
            return send(res, status, out);
          }
        }
        // POST /cancel — explicit cancel from mcp-server
        if (req.method === 'POST' && req.url === '/cancel') {
          const body = await readBody(req);
          const requestId =
            body && typeof body === 'object' && typeof (body as { requestId?: unknown }).requestId === 'string'
              ? (body as { requestId: string }).requestId
              : null;
          if (!requestId) return send(res, 400, { error: 'unknown', message: 'requestId required' });
          handlers.cancel(requestId);
          return send(res, 200, { ok: true });
        }
        // POST /<tool>  → registered handler
        if (req.method === 'POST' && req.url) {
          const route = req.url.replace(/^\//, '').split('?')[0]!;
          const handler = handlers.tools[route];
          if (handler) {
            const body = await readBody(req);
            const reqId =
              body && typeof body === 'object' && typeof (body as { _requestId?: unknown })._requestId === 'string'
                ? (body as { _requestId: string })._requestId
                : null;
            if (reqId) {
              const onClose = (): void => {
                if (!res.writableEnded) handlers.cancel(reqId);
              };
              req.on('close', onClose);
              res.on('finish', () => req.off('close', onClose));
            }
            const { status, body: out } = await handler(body);
            return send(res, status, out);
          }
        }
        send(res, 404, { error: 'not_found', message: `No route ${req.method} ${req.url}` });
      } catch (e) {
        send(res, 500, {
          error: 'internal_error',
          message: e instanceof Error ? e.message : String(e),
        });
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(sock, () => resolve()));
  fs.chmodSync(sock, 0o600);
  // BRIDGES_DIR import retained even though we already mkdir'd path.dirname(sock):
  // explicit import documents that the socket is expected under BRIDGES_DIR.
  void BRIDGES_DIR;
  return server;
}
