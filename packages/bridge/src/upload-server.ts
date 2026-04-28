// Loopback HTTP server used by browser_download_images.
//
// The Native Messaging frame size cap (~1 MB extension→host) makes streaming
// even modest images through it slow and brittle. So instead the bridge spins
// up a one-shot 127.0.0.1 server, hands the extension its random port + secret
// over NM, and the extension uploads each image as a plain POST. Bridge writes
// the bytes to disk under saveDir and replies with the local path.

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { htmlToMarkdown, ReadabilityNoArticleError, type ConvertOptions, type ConvertResult } from './readability-server.js';

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
  /** Same server, /readability route — used by browser_read_markdown. */
  readabilityEndpoint: string;
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

export async function startUploadServer(saveDir: string): Promise<UploadServer> {
  await fs.promises.mkdir(saveDir, { recursive: true, mode: 0o700 });
  const secret = crypto.randomBytes(16).toString('hex');

  const server = http.createServer((req, res) => {
    void (async () => {
      // CORS: extension fetches us from https://<site>/ — browser sends
      // a preflight OPTIONS before any POST that has a non-CORS-safe
      // content type. Reflect what's needed and we're done.
      const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Max-Age': '86400',
      };
      try {
        if (req.method === 'OPTIONS') {
          res.writeHead(204, corsHeaders);
          return res.end();
        }
        // ---- /readability route (read_markdown handler) ----
        // Body shape: { html, sourceUrl?, options: ConvertOptions }
        // Response (200): ConvertResult JSON
        // Response (400): { ok:false, code:'readability_no_article' | 'html_parse_failed', ... }
        if (req.method === 'POST') {
          const u0 = new URL(req.url ?? '', 'http://localhost');
          if (u0.pathname === '/readability') {
            if (extractSecret(req, u0) !== secret) {
              res.writeHead(403, corsHeaders);
              return res.end();
            }
            const chunks: Buffer[] = [];
            req.on('data', (c: Uint8Array) => chunks.push(Buffer.from(c)));
            req.on('end', () => {
              try {
                const raw = Buffer.concat(chunks).toString('utf-8');
                const parsed = JSON.parse(raw) as {
                  html?: unknown;
                  sourceUrl?: unknown;
                  options?: unknown;
                };
                const html = typeof parsed.html === 'string' ? parsed.html : '';
                const sourceUrl = typeof parsed.sourceUrl === 'string' ? parsed.sourceUrl : undefined;
                const optsIn = (parsed.options ?? {}) as Partial<ConvertOptions>;
                const opts: ConvertOptions = {
                  includeMetadata: optsIn.includeMetadata !== false,
                  includeImages: optsIn.includeImages !== false,
                  preserveCode: optsIn.preserveCode !== false,
                  maxLength: typeof optsIn.maxLength === 'number' ? optsIn.maxLength : undefined,
                };
                let result: ConvertResult;
                try {
                  result = htmlToMarkdown(html, opts, sourceUrl);
                } catch (e) {
                  if (e instanceof ReadabilityNoArticleError) {
                    res.writeHead(400, { ...corsHeaders, 'Content-Type': 'application/json' });
                    return res.end(
                      JSON.stringify({
                        ok: false,
                        code: 'readability_no_article',
                        htmlLength: e.htmlLength,
                      }),
                    );
                  }
                  res.writeHead(400, { ...corsHeaders, 'Content-Type': 'application/json' });
                  return res.end(
                    JSON.stringify({
                      ok: false,
                      code: 'html_parse_failed',
                      message: e instanceof Error ? e.message : String(e),
                    }),
                  );
                }
                res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, ...result }));
              } catch (e) {
                res.writeHead(500, { ...corsHeaders, 'Content-Type': 'application/json' });
                res.end(
                  JSON.stringify({
                    ok: false,
                    code: 'html_parse_failed',
                    message: e instanceof Error ? e.message : String(e),
                  }),
                );
              }
            });
            req.on('error', (err) => {
              res.writeHead(500, { ...corsHeaders, 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, code: 'html_parse_failed', message: err.message }));
            });
            return;
          }
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
        if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
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

        // Stream-byte limiter via PassThrough. Avoids the 'data' listener +
        // pipe race (two consumers fighting over the same readable stream)
        // by interposing our own duplex.
        const limiter = new PassThrough();
        let total = 0;
        let limiterFailed = false;
        limiter.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > MAX_UPLOAD_BYTES && !limiterFailed) {
            limiterFailed = true;
            limiter.destroy(new Error('upload too large'));
            req.destroy();
          }
        });

        const stream = fs.createWriteStream(outPath, { mode: 0o600 });
        req.pipe(limiter).pipe(stream);
        stream.on('finish', () => {
          if (limiterFailed) return; // close handler will clean up
          res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, path: outPath, size: total }));
        });
        // When the limiter destroys the stream mid-pipe we get 'close' (not
        // 'error') because pipe() teardown is graceful. So we hook both —
        // 'close' covers the "limiter killed us" path that would otherwise
        // leak the partial file.
        const cleanup = (err?: Error): void => {
          try {
            fs.unlinkSync(outPath);
          } catch {
            // already gone or never created
          }
          if (res.headersSent) return;
          if (limiterFailed) {
            res.writeHead(413, { ...corsHeaders, 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'upload too large' }));
            return;
          }
          res.writeHead(500, { ...corsHeaders, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err?.message ?? 'upload failed' }));
        };
        stream.on('error', cleanup);
        limiter.on('error', cleanup);
        stream.on('close', () => {
          // Only invoke cleanup on close if the upload failed — successful
          // finish already responded. limiterFailed implies the partial
          // file should not survive.
          if (limiterFailed) cleanup();
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
    readabilityEndpoint: `http://127.0.0.1:${port}/readability`,
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
