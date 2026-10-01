/** `byob policy` — show or change which sites byob may touch. */
import * as http from 'node:http';
import { listAliveBridges } from './bridge-registry.js';

export interface PolicyOptions {
  allow?: string[];
  deny?: string[];
  clearAllow?: boolean;
  clearDeny?: boolean;
  allowFile?: 'on' | 'off';
  allowAuth?: 'on' | 'off';
}

function post(socket: string, body: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { socketPath: socket, path: '/policy', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(buf) });
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}

export async function policy(opts: PolicyOptions): Promise<void> {
  const bridges = listAliveBridges();
  if (bridges.length === 0) {
    console.error('No live bridge — open Chrome with the byob extension enabled (see: byob doctor).');
    process.exitCode = 1;
    return;
  }
  const changes = !!(opts.clearAllow || opts.clearDeny || opts.allow?.length || opts.deny?.length || opts.allowFile || opts.allowAuth);
  for (const b of bridges) {
    // Each browser keeps its own lists: merge --allow/--deny into that
    // browser's lists, not into the first one's.
    const params: Record<string, unknown> = {};
    if (opts.allow?.length || opts.deny?.length) {
      const current = await post(b.socket, { params: {} });
      if (current.status >= 400) {
        console.error(`bridge ${b.deviceId}: ${current.body.message ?? current.status}`);
        process.exitCode = 1;
        continue;
      }
      if (opts.allow?.length) params.allowedDomains = [...(opts.clearAllow ? [] : current.body.allowedDomains ?? []), ...opts.allow];
      if (opts.deny?.length) params.deniedDomains = [...(opts.clearDeny ? [] : current.body.deniedDomains ?? []), ...opts.deny];
    }
    if (opts.clearAllow && !params.allowedDomains) params.allowedDomains = [];
    if (opts.clearDeny && !params.deniedDomains) params.deniedDomains = [];
    if (opts.allowFile) params.allowFile = opts.allowFile === 'on';
    if (opts.allowAuth) params.allowAuthDomains = opts.allowAuth === 'on';
    if (changes) console.log('If this widens access, confirm it in the Chrome window that opens…');
    const r = await post(b.socket, { params });
    if (r.status >= 400) {
      console.error(`bridge ${b.deviceId}: ${r.body.message ?? r.status}`);
      process.exitCode = 1;
      continue;
    }
    const p = r.body;
    console.log(`Browser ${b.deviceId.slice(0, 8)}:`);
    console.log(`  allowed domains : ${p.allowedDomains.length ? p.allowedDomains.join(', ') : '(any)'}`);
    console.log(`  denied domains  : ${p.deniedDomains.length ? p.deniedDomains.join(', ') : '(none)'}`);
    console.log(`  file:// URLs    : ${p.allowFile ? 'allowed' : 'blocked'}`);
    console.log(`  login pages     : ${p.allowAuthDomains ? 'allowed' : 'blocked (accounts.google.com, …)'}`);
  }
}
