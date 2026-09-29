/**
 * End-to-end harness: a throwaway Chrome for Testing with the byob extension
 * loaded, driven through the real MCP server exactly the way an agent would.
 *
 * Isolation from the developer's own browser:
 *  - the extension is built into packages/extension/output-e2e, never the
 *    `output/` directory the user's Chrome has loaded unpacked;
 *  - the bridge runs with BYOB_HOME pointing at ~/.cache/byob-e2e/home, so its
 *    registry/socket never appear to the user's MCP clients;
 *  - the Native Messaging manifest is written only into Chrome for Testing's
 *    own directory, which the user's Chrome never reads.
 *
 * Requires Chrome for Testing:
 *   bunx @puppeteer/browsers install chrome@stable --path ~/.cache/byob-e2e
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { computeExtensionId } from '../packages/bridge/src/extension-id.js';

const REPO = path.resolve(import.meta.dir, '..');
const CACHE = path.join(os.homedir(), '.cache', 'byob-e2e');
const E2E_HOME = path.join(CACHE, 'home');
const PROFILE = path.join(CACHE, 'profile');
const EXT_OUT = path.join(REPO, 'packages/extension/output-e2e/chrome-mv3');
const HOST_NAME = 'ai.byob.bridge';

function findChrome(): string {
  if (process.env.BYOB_E2E_CHROME) return process.env.BYOB_E2E_CHROME;
  const base = path.join(CACHE, 'chrome');
  const builds = fs.existsSync(base) ? fs.readdirSync(base).sort().reverse() : [];
  for (const b of builds) {
    const mac = path.join(
      base, b, 'chrome-mac-arm64',
      'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    );
    const macX64 = mac.replace('chrome-mac-arm64', 'chrome-mac-x64');
    const linux = path.join(base, b, 'chrome-linux64', 'chrome');
    for (const p of [mac, macX64, linux]) if (fs.existsSync(p)) return p;
  }
  throw new Error(
    'Chrome for Testing not found. Run: bunx @puppeteer/browsers install chrome@stable --path ~/.cache/byob-e2e',
  );
}

function nmHostDir(): string {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library/Application Support/Google/Chrome for Testing/NativeMessagingHosts');
  }
  return path.join(os.homedir(), '.config/google-chrome-for-testing/NativeMessagingHosts');
}

function extensionId(): string {
  const pem = fs.readFileSync(path.join(os.homedir(), '.byob', 'extension-key.pem'));
  const pub = crypto.createPublicKey(crypto.createPrivateKey(pem));
  const der = pub.export({ type: 'spki', format: 'der' }) as Buffer;
  return computeExtensionId(der.toString('base64'));
}

function buildExtension(): void {
  if (process.env.BYOB_E2E_SKIP_BUILD === '1' && fs.existsSync(EXT_OUT)) return;
  const r = spawnSync('bun', ['run', 'build'], {
    cwd: path.join(REPO, 'packages/extension'),
    env: { ...process.env, BYOB_OUT_DIR: 'output-e2e' },
    encoding: 'utf-8',
  });
  if (r.status !== 0) throw new Error(`extension build failed:\n${r.stdout}\n${r.stderr}`);
}

function installNativeHost(): void {
  fs.mkdirSync(E2E_HOME, { recursive: true, mode: 0o700 });
  const tsx = path.join(REPO, 'packages/bridge/node_modules/.bin/tsx');
  const entry = path.join(REPO, 'packages/bridge/bin/byob-bridge.ts');
  const launcher = path.join(E2E_HOME, 'bridge-host.sh');
  fs.writeFileSync(
    launcher,
    `#!/bin/sh\nexport BYOB_HOME="${E2E_HOME}"\nexport PATH="${path.dirname(process.execPath)}:/opt/homebrew/bin:/usr/local/bin:$PATH"\nexec "${tsx}" "${entry}" "$@"\n`,
    { mode: 0o755 },
  );
  const manifest = JSON.stringify({
    name: HOST_NAME,
    description: 'byob e2e bridge',
    path: launcher,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId()}/`],
  }, null, 2);
  for (const dir of [nmHostDir(), path.join(PROFILE, 'NativeMessagingHosts')]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${HOST_NAME}.json`), manifest);
  }
}

interface RegistryEntry { deviceId: string; pid: number; socket: string }

function liveBridge(): RegistryEntry | null {
  try {
    const entries = JSON.parse(
      fs.readFileSync(path.join(E2E_HOME, 'bridges.json'), 'utf-8'),
    ) as RegistryEntry[];
    for (const e of entries) {
      try {
        process.kill(e.pid, 0);
        return e;
      } catch { /* dead */ }
    }
  } catch { /* no registry yet */ }
  return null;
}

async function waitFor<T>(fn: () => T | null, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Two origins on different sites, so iframes across them become OOPIFs. */
function startFixtureServers(): { primary: string; secondary: string; stop: () => void } {
  const dir = path.join(REPO, 'e2e/fixtures');
  let cross = '';
  const handler = (req: Request): Response => {
    const url = new URL(req.url);
    const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.join(dir, path.normalize(name));
    if (!file.startsWith(dir) || !fs.existsSync(file)) return new Response('not found', { status: 404 });
    if (file.endsWith('.html')) {
      const html = fs.readFileSync(file, 'utf-8').replaceAll('{{CROSS}}', cross);
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    return new Response(Bun.file(file));
  };
  const a = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: handler });
  const b = Bun.serve({ hostname: 'localhost', port: 0, fetch: handler });
  cross = `http://localhost:${b.port}`;
  return {
    primary: `http://127.0.0.1:${a.port}`,
    secondary: `http://localhost:${b.port}`,
    stop: () => { a.stop(true); b.stop(true); },
  };
}

export interface ToolResult {
  isError: boolean;
  text: string;
  /** JSON-parsed text when the tool returned JSON, else undefined. */
  json?: any;
  images: Array<{ data: string; mimeType: string }>;
}

export interface E2E {
  origin: string;
  crossOrigin: string;
  call: (name: string, args?: Record<string, unknown>) => Promise<ToolResult>;
  listTools: () => Promise<Array<{ name: string; description?: string; inputSchema: unknown }>>;
  close: () => Promise<void>;
}

export async function startE2E(): Promise<E2E> {
  buildExtension();
  fs.rmSync(PROFILE, { recursive: true, force: true });
  fs.rmSync(path.join(E2E_HOME, 'bridges.json'), { force: true });
  installNativeHost();
  const servers = startFixtureServers();

  const chrome: ChildProcess = spawn(findChrome(), [
    `--user-data-dir=${PROFILE}`,
    `--load-extension=${EXT_OUT}`,
    `--disable-extensions-except=${EXT_OUT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-search-engine-choice-screen',
    '--disable-background-networking',
    '--window-size=1280,900',
    ...(process.env.BYOB_E2E_HEADED === '1' ? [] : ['--headless=new']),
    'about:blank',
  ], { stdio: 'ignore' });

  let client: Client | null = null;
  const close = async (): Promise<void> => {
    try { await client?.close(); } catch { /* ignore */ }
    chrome.kill('SIGTERM');
    servers.stop();
  };

  try {
    await waitFor(liveBridge, 30_000, 'byob bridge to register (extension ↔ native host)');
    const transport = new StdioClientTransport({
      command: path.join(REPO, 'packages/mcp-server/node_modules/.bin/tsx'),
      args: [path.join(REPO, 'packages/mcp-server/bin/byob-mcp.ts')],
      env: { ...process.env, BYOB_HOME: E2E_HOME, BYOB_ALLOW_EVAL: '1' } as Record<string, string>,
      stderr: 'ignore',
    });
    client = new Client({ name: 'byob-e2e', version: '0' });
    await client.connect(transport);
  } catch (e) {
    await close();
    throw e;
  }

  const c = client;
  return {
    origin: servers.primary,
    crossOrigin: servers.secondary,
    async call(name, args = {}) {
      const res = (await c.callTool({ name, arguments: args })) as {
        isError?: boolean;
        content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
      };
      const text = res.content.filter((x) => x.type === 'text').map((x) => x.text ?? '').join('\n');
      let json: unknown;
      try { json = JSON.parse(text); } catch { json = undefined; }
      return {
        isError: res.isError === true,
        text,
        json,
        images: res.content
          .filter((x) => x.type === 'image')
          .map((x) => ({ data: x.data ?? '', mimeType: x.mimeType ?? '' })),
      };
    },
    async listTools() {
      return (await c.listTools()).tools;
    },
    close,
  };
}
