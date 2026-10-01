import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { launcherBody, parseLauncher } from './launcher.js';

describe('launcher', () => {
  it('bundle launcher on POSIX runs node on the installed bundle', () => {
    const body = launcherBody({ win: false, nodeDir: '/opt/homebrew/opt/node/bin', argv: ['/opt/homebrew/opt/node/bin/node', '/Users/me/.byob/bridge/byob-bridge.mjs'] }, 'bundle');
    expect(body.startsWith('#!/bin/sh\n')).toBe(true);
    expect(body).toContain('export PATH="/opt/homebrew/opt/node/bin:$PATH"');
    expect(body).toContain('exec "/opt/homebrew/opt/node/bin/node" "/Users/me/.byob/bridge/byob-bridge.mjs" "$@"');
    expect(parseLauncher(body)).toEqual({ mode: 'bundle', argv: ['/opt/homebrew/opt/node/bin/node', '/Users/me/.byob/bridge/byob-bridge.mjs'] });
  });

  it('Windows launcher is a CRLF .cmd that forwards %*', () => {
    const body = launcherBody({ win: true, nodeDir: 'C:\\Program Files\\nodejs', argv: ['C:\\Program Files\\nodejs\\node.exe', 'C:\\Users\\me\\.byob\\bridge\\byob-bridge.mjs'] }, 'bundle');
    expect(body.startsWith('@echo off\r\n')).toBe(true);
    expect(body.endsWith('\r\n')).toBe(true);
    expect(body).toContain('set "PATH=C:\\Program Files\\nodejs;%PATH%"');
    expect(body).toContain('"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\me\\.byob\\bridge\\byob-bridge.mjs" %*');
    expect(parseLauncher(body).mode).toBe('bundle');
  });

  it('dev launcher runs the TypeScript source through tsx; env is exported first', () => {
    const body = launcherBody({ win: false, nodeDir: '/usr/bin', argv: ['/repo/packages/bridge/node_modules/.bin/tsx', '/repo/packages/bridge/bin/byob-bridge.ts'], env: { BYOB_HOME: '/tmp/h' } }, 'source');
    expect(body.indexOf('export BYOB_HOME="/tmp/h"')).toBeLessThan(body.indexOf('exec '));
    expect(parseLauncher(body)).toEqual({ mode: 'source', argv: ['/repo/packages/bridge/node_modules/.bin/tsx', '/repo/packages/bridge/bin/byob-bridge.ts'] });
  });

  it('reads launchers written by earlier versions', () => {
    const v05 = '#!/bin/sh\nexport PATH="/usr/local/bin:$PATH"\nexec "/repo/packages/bridge/node_modules/.bin/tsx" "/repo/packages/bridge/bin/byob-bridge.ts" "$@"\n';
    expect(parseLauncher(v05).mode).toBe('source');
    expect(parseLauncher('garbage').mode).toBe('unknown');
  });
});

// The bundle must run under plain Node (Chrome starts it with no tsx, no bun).
const node = Bun.which('node');
describe.skipIf(!node)('bridge bundle', () => {
  it('builds to one file that starts and shuts down cleanly under node', async () => {
    const out = fs.mkdtempSync(path.join(process.env.BYOB_HOME!, 'bundle-'));
    // Same command as the root `build:bridge` script.
    const entry = path.resolve(import.meta.dir, '../../bin/byob-bridge.ts');
    const b = spawnSync(process.execPath, ['build', entry, '--target=node', '--format=esm', `--outfile=${path.join(out, 'byob-bridge.mjs')}`], { encoding: 'utf8' });
    expect(b.status).toBe(0);
    expect(fs.readdirSync(out)).toEqual(['byob-bridge.mjs']);
    const home = path.join(out, 'home');
    const run = spawnSync(node!, [path.join(out, 'byob-bridge.mjs')], { input: '', env: { ...process.env, BYOB_HOME: home }, encoding: 'utf8', timeout: 15_000 });
    expect(run.status).toBe(0);
    const log = fs.readFileSync(path.join(home, 'bridge.log'), 'utf8');
    expect(log).toMatch(/bridge started, v[\d.]+, pid=\d+\n.*shutdown: stdin_end/);
  }, 30_000);
});
