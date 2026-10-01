// Loopback HTTP server used by browser_download_images.
//
// Native Messaging is a poor pipe for image bytes: everything goes through
// JSON + base64, and anything the bridge sends back to the extension is capped
// at 1 MiB per message. So instead the bridge spins
// up a one-shot 127.0.0.1 server, hands the extension its random port + secret
// over NM, and the extension uploads each image as a plain POST. Bridge writes
// the bytes to disk under saveDir and replies with the local path.

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { pipeline, Transform } from 'node:stream';

// Accept up to 100 MiB per upload. Loopback only, but a runaway extension or
// a malicious page that smuggled the secret should not be able to fill the
// disk. Real images on the web rarely exceed this.
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/** Pull the upload secret from Authorization: Bearer ..., falling back to
 *  the legacy ?secret= query for older extension builds. */
function extractSecret(req: http.IncomingMessage, u: URL): string {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return auth.slice(7).trim();
  }
  return u.searchParams.get('secret') ?? '';
}

export interface UploadServer {
  port: number;
  secret: string;
  endpoint: string;
  close(): Promise<void>;
}

function sanitizeFilename(raw: string): string {
  let name: string;
  try {
    name = decodeURIComponent(raw);
  } catch {
    name = raw;
  }
  // strip path separators + control chars + leading dots
  name = name.replace(/[\\/]+/g, '_').replace(/[\x00-\x1f<>:"|?*]+/g, '_').replace(/^\.+/, '').trim();
  if (!name || name === '.' || name === '..') name = 'image';
  return name.length > 180 ? name.slice(0, 180) : name;
}

function uniquify(dir: string, filename: string): string {
  let candidate = path.join(dir, filename);
  if (!fs.existsSync(candidate)) return candidate;
  const dot = filename.lastIndexOf('.');
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : '';
  for (let i = 1; i < 10_000; i++) {
    candidate = path.join(dir, `${stem}-${i}${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return path.join(dir, `${stem}-${Date.now()}${ext}`);
}

export async function startUploadServer(saveDir: string, maxBytes = MAX_UPLOAD_BYTES): Promise<UploadServer> {
  await fs.promises.mkdir(saveDir, { recursive: true, mode: 0o700 });
  const secret = crypto.randomBytes(16).toString('hex');

  const server = http.createServer((req, res) => {
    void (async () => {
      // No CORS headers — the caller (download-images)
      // fetch from the extension's service worker, which is not subject
      // to CORS. Sending `Access-Control-Allow-Origin: *` would let any
      // open web page that learned the port + secret POST files here
      // and overwrite anything in saveDir; the Bearer token is the only
      // gate, and CORS is the second line of defense — keep it shut.
      const corsHeaders: Record<string, string> = {};
      try {
        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          return res.end();
        }
        if (req.method !== 'POST') {
          res.writeHead(405, corsHeaders);
          return res.end();
        }
        const u = new URL(req.url ?? '', 'http://localhost');
        if (u.pathname !== '/upload') {
          res.writeHead(404, corsHeaders);
          return res.end();
        }
        if (extractSecret(req, u) !== secret) {
          res.writeHead(403, corsHeaders);
          return res.end();
        }

        // Reject obvious oversize uploads up-front via Content-Length;
        // streaming check below catches Transfer-Encoding: chunked liars.
        const declared = Number(req.headers['content-length'] ?? '0');
        if (Number.isFinite(declared) && declared > maxBytes) {
          res.writeHead(413, corsHeaders);
          return res.end();
        }

        const indexStr = u.searchParams.get('index') ?? '0';
        // Filename comes via URL query (CORS-safe, no preflight needed).
        // Falls back to header for backward compat.
        const queryName = u.searchParams.get('filename');
        const headerName = req.headers['x-filename'];
        const rawName =
          (typeof queryName === 'string' && queryName.length > 0 && queryName) ||
          (typeof headerName === 'string' && headerName.length > 0 ? headerName : `image-${indexStr}`);
        const filename = sanitizeFilename(rawName);
        const outPath = uniquify(saveDir, filename);

        // Defense-in-depth: even after sanitizeFilename strips separators
        // and uniquify uses path.join, verify the resolved path stays within
        // saveDir. Catches unicode-homograph / future regression bugs.
        const resolvedDir = path.resolve(saveDir);
        const resolvedOut = path.resolve(outPath);
        if (
          resolvedOut !== resolvedDir &&
          !resolvedOut.startsWith(resolvedDir + path.sep)
        ) {
          res.writeHead(400, corsHeaders);
          return res.end();
        }

        // Count bytes as they stream: Content-Length can be absent (chunked)
        // or a lie.
        let total = 0;
        let tooLarge = false;
        const limiter = new Transform({
          transform(chunk: Buffer, _enc, cb) {
            total += chunk.length;
            if (total > maxBytes) {
              tooLarge = true;
              cb(new Error('upload too large'));
              return;
            }
            cb(null, chunk);
          },
        });
        // 'wx': never follow or clobber something that appeared at outPath
        // after uniquify() looked.
        const file = fs.createWriteStream(outPath, { mode: 0o600, flags: 'wx' });
        let created = false;
        file.once('open', () => {
          created = true;
        });
        // pipeline() tears every stream down on any failure — an aborted
        // request, the size limit, a disk error — so no half-written file or
        // open descriptor outlives a failed upload.
        pipeline(req, limiter, file, (err) => {
          if (!err) {
            res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, path: outPath, size: total }));
            return;
          }
          if (created) {
            try {
              fs.unlinkSync(outPath);
            } catch {
              // already gone
            }
          }
          if (res.headersSent || res.destroyed) return;
          res.writeHead(tooLarge ? 413 : 500, { ...corsHeaders, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: tooLarge ? 'upload too large' : err.message }));
        });
      } catch (e) {
        res.writeHead(500, corsHeaders);
        res.end(String(e instanceof Error ? e.message : e));
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('upload server failed to bind a port');
  }
  const port = address.port;

  return {
    port,
    secret,
    endpoint: `http://127.0.0.1:${port}/upload`,
    close: () =>
      new Promise<void>((resolve) => {
        try {
          server.closeAllConnections?.();
        } catch {
          // ignore
        }
        server.close(() => resolve());
      }),
  };
}
