/**
 * End-to-end harness: a throwaway Chrome for Testing with the byob extension
 * loaded, driven through the real MCP server exactly the way an agent would.
 *
 * Isolation from the developer's own browser:
 *  - the extension is built into packages/extension/output-e2e, never the
 *    `output/` directory the user's Chrome has loaded unpacked, and signed
 *    with a throwaway key (~/.cache/byob-e2e/extension-key.pem, or
 *    BYOB_KEY_PATH), never ~/.byob's;
 *  - the bridge runs with BYOB_HOME pointing at ~/.cache/byob-e2e/home, so its
 *    registry/socket never appear to the user's MCP clients;
 *  - the Native Messaging manifest is written only into the throwaway
 *    profile (`<user-data-dir>/NativeMessagingHosts` is where Chrome looks
 *    for user-level hosts on macOS and Linux), which nothing else reads.
 *
 * BYOB_E2E_BUNDLE=1 runs the release artifacts instead of TypeScript source:
 * the single-file bridge (packages/bridge/dist, built here) and the Claude
 * plugin's MCP server (plugins/byob/servers, as committed).
 *
 * macOS and Linux only. Requires Chrome for Testing:
 *   bunx @puppeteer/browsers install chrome@stable --path ~/.cache/byob-e2e
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { computeExtensionId } from '../packages/bridge/src/extension-id.js';
import { launcherBody } from '../packages/bridge/src/install/launcher.js';

const REPO = path.resolve(import.meta.dir, '..');
const CACHE = path.join(os.homedir(), '.cache', 'byob-e2e');
// BYOB_E2E_RUN=<name> gives a run its own profile, bridge home and log, so
// several checkouts can run e2e at once. Chrome and the key stay shared.
// Keep the name short: the bridge socket lives under it (104-byte limit).
const RUN_DIR = process.env.BYOB_E2E_RUN ? path.join(CACHE, 'runs', process.env.BYOB_E2E_RUN) : CACHE;
const E2E_HOME = path.join(RUN_DIR, 'home');
const PROFILE = path.join(RUN_DIR, 'profile');
const DOWNLOADS = path.join(RUN_DIR, 'downloads');
const KEY_PATH = process.env.BYOB_KEY_PATH || path.join(CACHE, 'extension-key.pem');
const EXT_OUT = path.join(REPO, 'packages/extension/output-e2e/chrome-mv3');
const HOST_NAME = 'ai.byob.bridge';
const BUNDLED = process.env.BYOB_E2E_BUNDLE === '1';

function findChrome(): string {
  if (process.env.BYOB_E2E_CHROME) return process.env.BYOB_E2E_CHROME;
  const base = path.join(CACHE, 'chrome');
  // Newest first; numeric so 154.x sorts above 99.x.
  const builds = fs.existsSync(base) ? fs.readdirSync(base).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })) : [];
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

/** The key the e2e extension is signed with; generated on first use (CI has none). */
function extensionId(): string {
  if (!fs.existsSync(KEY_PATH)) {
    fs.mkdirSync(path.dirname(KEY_PATH), { recursive: true, mode: 0o700 });
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    fs.writeFileSync(KEY_PATH, privateKey.export({ type: 'pkcs1', format: 'pem' }), { mode: 0o600 });
  }
  const pub = crypto.createPublicKey(crypto.createPrivateKey(fs.readFileSync(KEY_PATH)));
  const der = pub.export({ type: 'spki', format: 'der' }) as Buffer;
  return computeExtensionId(der.toString('base64'));
}

function run(cmd: string, args: string[], cwd: string, env: Record<string, string> = {}): void {
  const r = spawnSync(cmd, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`);
}

function buildExtension(): void {
  if (process.env.BYOB_E2E_SKIP_BUILD === '1' && fs.existsSync(EXT_OUT)) return;
  run('bun', ['run', 'build'], path.join(REPO, 'packages/extension'), { BYOB_OUT_DIR: 'output-e2e', BYOB_KEY_PATH: KEY_PATH });
}

function installNativeHost(id: string): void {
  fs.mkdirSync(E2E_HOME, { recursive: true, mode: 0o700 });
  // Chrome starts the host with a minimal environment; resolve node now.
  const node = Bun.which('node');
  if (!node) throw new Error('node not found on PATH (the bridge runs under Node)');
  let argv: string[];
  if (BUNDLED) {
    run('bun', ['run', 'build:bridge'], REPO);
    argv = [node, path.join(REPO, 'packages/bridge/dist/byob-bridge.mjs')];
  } else {
    argv = [path.join(REPO, 'packages/bridge/node_modules/.bin/tsx'), path.join(REPO, 'packages/bridge/bin/byob-bridge.ts')];
  }
  const launcher = path.join(E2E_HOME, 'bridge-host.sh');
  fs.writeFileSync(
    launcher,
    launcherBody({ win: false, nodeDir: path.dirname(node), argv, env: { BYOB_HOME: E2E_HOME } }, BUNDLED ? 'bundle' : 'source'),
    { mode: 0o755 },
  );
  const manifest = JSON.stringify({
    name: HOST_NAME,
    description: 'byob e2e bridge',
    path: launcher,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${id}/`],
  }, null, 2);
  const dir = path.join(PROFILE, 'NativeMessagingHosts');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${HOST_NAME}.json`), manifest);
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
  extensionId: string;
  /** POST the bridge's CLI-only /policy route (what `byob policy` does). */
  policy: (params: Record<string, unknown>) => Promise<{ status: number; body: any }>;
  origin: string;
  crossOrigin: string;
  /** Where the test Chrome saves downloads. */
  downloadsDir: string;
  call: (name: string, args?: Record<string, unknown>) => Promise<ToolResult>;
  listTools: () => Promise<Array<{ name: string; description?: string; inputSchema: unknown }>>;
  /** notifications/tools/list_changed received so far. */
  toolListChanges: () => number;
  close: () => Promise<void>;
}

export async function startE2E(): Promise<E2E> {
  const id = extensionId();
  buildExtension();
  fs.rmSync(PROFILE, { recursive: true, force: true });
  fs.rmSync(path.join(E2E_HOME, 'bridges.json'), { force: true });
  // Downloads land in the run's own folder, never the developer's ~/Downloads.
  fs.rmSync(DOWNLOADS, { recursive: true, force: true });
  fs.mkdirSync(DOWNLOADS, { recursive: true });
  fs.mkdirSync(path.join(PROFILE, 'Default'), { recursive: true });
  fs.writeFileSync(path.join(PROFILE, 'Default', 'Preferences'), JSON.stringify({
    download: { default_directory: DOWNLOADS, prompt_for_download: false, directory_upgrade: true },
    savefile: { default_directory: DOWNLOADS },
  }));
  installNativeHost(id);
  const servers = startFixtureServers();

  // Chrome's stderr goes to a file: when it fails to start (missing libs,
  // sandbox) the test only sees "timed out waiting for bridge" otherwise.
  fs.mkdirSync(RUN_DIR, { recursive: true });
  const chromeLog = fs.openSync(path.join(RUN_DIR, 'chrome.log'), 'w');
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
    // Extra launch flags for a run, e.g. --extensions-on-chrome-urls.
    ...(process.env.BYOB_E2E_CHROME_ARGS ? process.env.BYOB_E2E_CHROME_ARGS.split(/\s+/).filter(Boolean) : []),
    // CI Linux runners block the user namespaces Chrome's sandbox needs.
    ...(process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : []),
    'about:blank',
  ], { stdio: ['ignore', 'ignore', chromeLog] });
  fs.closeSync(chromeLog);

  let client: Client | null = null;
  let listChanged = 0;
  const close = async (): Promise<void> => {
    try { await client?.close(); } catch { /* ignore */ }
    // Wait for Chrome to exit: the next test file reuses the profile, and a
    // live instance would take over its launch.
    const exited = new Promise<void>((r) => {
      if (chrome.exitCode !== null || chrome.signalCode !== null) r();
      chrome.once('exit', () => r());
      setTimeout(r, 5000).unref();
    });
    chrome.kill('SIGTERM');
    await exited;
    servers.stop();
  };

  try {
    await waitFor(liveBridge, 30_000, 'byob bridge to register (extension ↔ native host)');
    const transport = new StdioClientTransport({
      command: BUNDLED ? 'node' : path.join(REPO, 'packages/mcp-server/node_modules/.bin/tsx'),
      args: [BUNDLED ? path.join(REPO, 'plugins/byob/servers/byob-mcp.mjs') : path.join(REPO, 'packages/mcp-server/bin/byob-mcp.ts')],
      env: { ...process.env, BYOB_HOME: E2E_HOME, BYOB_ALLOW_EVAL: '1' } as Record<string, string>,
      stderr: 'ignore',
    });
    client = new Client({ name: 'byob-e2e', version: '0' });
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => { listChanged++; });
    await client.connect(transport);
  } catch (e) {
    await close();
    throw e;
  }

  const c = client;
  const bridge = liveBridge()!;
  return {
    extensionId: id,
    async policy(params) {
      const http = await import('node:http');
      return new Promise((resolve, reject) => {
        const data = JSON.stringify({ params });
        const req = http.request({ socketPath: bridge.socket, path: '/policy', method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
          let buf = '';
          res.on('data', (d) => (buf += d));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(buf) }));
        });
        req.on('error', reject);
        req.end(data);
      });
    },
    origin: servers.primary,
    crossOrigin: servers.secondary,
    downloadsDir: DOWNLOADS,
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
    toolListChanges: () => listChanged,
    close,
  };
}
