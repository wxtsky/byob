import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as readline from 'node:readline';
import { execSync, spawnSync } from 'node:child_process';
import { computeExtensionId } from './extension-id.js';
import { BYOB_DIR, LAUNCHER_PATH, BRIDGES_DIR } from './paths.js';
import { listAliveBridges } from './bridge-registry.js';

const NATIVE_HOST_NAME = 'ai.byob.bridge';
const PEM_PATH = path.join(BYOB_DIR, 'extension-key.pem');
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

type Lang = 'en' | 'zh';
let lang: Lang = 'en';

const messages = {
  langPrompt: '  Language / 语言:\n    1) English\n    2) 中文\n',
  langAsk: '  Choice / 选择 [1/2]: ',
  installDone: { en: 'byob installed', zh: 'byob 已安装' },
  installSubtitle: {
    en: '4 steps left to wire it up',
    zh: '剩 4 步即可使用',
  },
  clipboardCopied: { en: '(copied to clipboard)', zh: '（已复制到剪贴板）' },
  nextSteps: { en: 'Next steps:', zh: '接下来：' },
  step1Title: { en: 'Load the extension into Chrome', zh: '在 Chrome 中加载扩展' },
  step1Open: { en: 'Open chrome://extensions in Chrome.', zh: '在 Chrome 中打开 chrome://extensions' },
  step1Dev: { en: 'Top-right: turn ON "Developer mode"', zh: '右上角：打开「开发者模式」' },
  step1Load: { en: 'Top-left: click "Load unpacked"', zh: '左上角：点「加载已解压的扩展程序」' },
  step1Pick: { en: 'Pick the folder:', zh: '选择目录：' },
  step2Title: { en: 'Restart Chrome', zh: '重启 Chrome' },
  step2Quit: {
    en: `${IS_WIN ? 'Close every Chrome window' : 'Quit Chrome with ⌘Q'} (closing only a tab is NOT enough), then reopen.`,
    zh: `${IS_WIN ? '关掉所有 Chrome 窗口' : '⌘Q 退出 Chrome'}（只关标签页不行），然后重新打开。`,
  },
  step2Why: {
    en: 'Chrome only reads the bridge manifest at startup.',
    zh: 'Chrome 只在启动时读取 bridge 配置。',
  },
  step3Title: { en: 'Register the MCP server with your AI tool', zh: '将 MCP 服务器注册到你的 AI 工具' },
  step3Choose: {
    en: 'Which AI tools do you use? (↑↓ move, space select, enter confirm)',
    zh: '你使用哪些 AI 工具？（↑↓ 移动，空格 选择，回车 确认）',
  },
  step3Skip: { en: 'Skipped. The MCP server command is:', zh: '已跳过。MCP 服务器命令为：' },
  step3SeeReadme: { en: 'See README for configuration examples.', zh: '详见 README 的配置示例。' },
  step3NotFound: { en: 'not found on PATH. Run manually:', zh: '未找到命令，请手动执行：' },
  step3Failed: { en: 'command failed. Run manually:', zh: '命令执行失败，请手动执行：' },
  step3Registered: { en: 'registered', zh: '已注册' },
  step3Wrote: { en: 'wrote', zh: '已写入' },
  step3Configured: { en: 'tool(s) configured. To enable browser_eval, set BYOB_ALLOW_EVAL=1.', zh: '个工具已配置。启用 browser_eval 请设置 BYOB_ALLOW_EVAL=1。' },
  step4Title: { en: 'Wait for bridge', zh: '等待 bridge 上线' },
  step4Hint: {
    en: 'After steps ① and ②, the bridge comes online automatically.',
    zh: '完成 ① 和 ② 之后，bridge 会自动上线。',
  },
  step4Waiting: { en: 'waiting for bridge', zh: '等待 bridge 中' },
  step4OnlineHeadline: {
    en: "bridge online — you're all set",
    zh: 'bridge 已上线 — 全部就绪',
  },
  step4OnlineTry: { en: 'Try in your AI tool:', zh: '在 AI 工具里试一下：' },
  step4OnlineExample: {
    en: '"use byob to read example.com"',
    zh: '「用 byob 读 example.com」',
  },
  step4TimeoutHeadline: {
    en: 'timed out — bridge did not come online within 5 minutes',
    zh: '超时 — 5 分钟内 bridge 未上线',
  },
  step4CommonCauses: { en: 'Most common causes:', zh: '最常见的原因：' },
  step4Tip1: {
    en: IS_WIN
      ? 'Chrome must be fully closed (every window) before reopening'
      : 'Chrome must be fully ⌘Q-ed (closing windows is NOT enough)',
    zh: IS_WIN
      ? '必须关掉所有 Chrome 窗口再重新打开'
      : '必须 ⌘Q 完全退出 Chrome（只关窗口不够）',
  },
  step4Tip2: {
    en: 'Extension ID mismatch → run: rm ~/.byob/extension-key.pem && bun run setup',
    zh: '扩展 ID 不一致 → 跑：rm ~/.byob/extension-key.pem && bun run setup',
  },
  step4Tip3: {
    en: 'Wrong browser — manifest is for Chrome; did you load it in Brave/Edge?',
    zh: '装错浏览器了 — manifest 写给 Chrome，你装到 Brave/Edge 上了吗？',
  },
  step4DoctorRetry: {
    en: 'Run `bun run doctor` to re-check anytime.',
    zh: '随时跑 `bun run doctor` 复查。',
  },
} as const;

function t(key: keyof typeof messages): string {
  const val = messages[key];
  if (typeof val === 'string') return val;
  return val[lang];
}

function findCli(name: string): string | null {
  const commonDirs = [
    path.join(os.homedir(), '.local', 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
    path.join(os.homedir(), '.bun', 'bin'),
    path.join(os.homedir(), '.cargo', 'bin'),
  ];
  // Check PATH first
  try {
    const r = spawnSync(IS_WIN ? 'where' : 'which', [name], {
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, PATH: `${commonDirs.join(path.delimiter)}${path.delimiter}${process.env['PATH'] ?? ''}` },
    });
    if (r.status === 0 && r.stdout) {
      const found = r.stdout.toString().trim().split('\n')[0]!.trim();
      if (found) return found;
    }
  } catch { /* fall through */ }
  // Direct scan
  for (const dir of commonDirs) {
    const full = path.join(dir, IS_WIN ? `${name}.cmd` : name);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

async function askLang(): Promise<Lang> {
  if (!process.stdin.isTTY) return 'en';
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    process.stdout.write(messages.langPrompt);
    rl.question(messages.langAsk, (answer) => {
      rl.close();
      resolve(answer.trim() === '2' ? 'zh' : 'en');
    });
  });
}

/**
 * A browser to install the Native Messaging host into.
 *
 * - On macOS / Linux Chrome reads the manifest from a per-browser
 *   `NativeMessagingHosts/<host>.json` file. `manifestPath` is that file
 *   and `register()` simply writes it.
 * - On Windows Chrome reads the manifest path from a registry key under
 *   `HKCU\Software\<Vendor>\<Browser>\NativeMessagingHosts\<host>`.
 *   We still need the JSON on disk somewhere — we centralise it under
 *   `~/.byob/<host>.json` rather than once per browser — and `register()`
 *   shells out to `reg add` to point the registry key at it.
 */
interface BrowserEntry {
  name: string;
  manifestPath: string;
  installed: () => boolean;
  /** Persist the manifest so this browser will pick it up. */
  register: (manifestJson: string) => void;
}

function browserEntries(): BrowserEntry[] {
  const home = os.homedir();
  switch (process.platform) {
    case 'darwin':
      return [
        fsBrowserEntry(
          'Chrome',
          path.join(
            home,
            'Library/Application Support/Google/Chrome/NativeMessagingHosts',
            `${NATIVE_HOST_NAME}.json`,
          ),
          () => fs.existsSync('/Applications/Google Chrome.app'),
        ),
        fsBrowserEntry(
          'Brave',
          path.join(
            home,
            'Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts',
            `${NATIVE_HOST_NAME}.json`,
          ),
          () => fs.existsSync('/Applications/Brave Browser.app'),
        ),
        fsBrowserEntry(
          'Edge',
          path.join(
            home,
            'Library/Application Support/Microsoft Edge/NativeMessagingHosts',
            `${NATIVE_HOST_NAME}.json`,
          ),
          () => fs.existsSync('/Applications/Microsoft Edge.app'),
        ),
      ];
    case 'linux':
      return [
        fsBrowserEntry(
          'Chrome',
          path.join(home, '.config/google-chrome/NativeMessagingHosts', `${NATIVE_HOST_NAME}.json`),
          () => true,
        ),
        fsBrowserEntry(
          'Brave',
          path.join(
            home,
            '.config/BraveSoftware/Brave-Browser/NativeMessagingHosts',
            `${NATIVE_HOST_NAME}.json`,
          ),
          () => true,
        ),
      ];
    case 'win32': {
      // One JSON file per browser, all under ~/.byob/, keyed by browser
      // name so they're easy to delete on uninstall.
      const winManifest = (browser: string) =>
        path.join(BYOB_DIR, `${NATIVE_HOST_NAME}.${browser}.json`);
      return [
        winBrowserEntry(
          'Chrome',
          winManifest('chrome'),
          `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
        ),
        winBrowserEntry(
          'Brave',
          winManifest('brave'),
          `HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
        ),
        winBrowserEntry(
          'Edge',
          winManifest('edge'),
          `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
        ),
      ];
    }
    default:
      throw new Error(`Unsupported platform: ${process.platform}`);
  }
}

/** Default macOS / Linux browser entry: just write the manifest JSON file. */
function fsBrowserEntry(
  name: string,
  manifestPath: string,
  installed: () => boolean,
): BrowserEntry {
  return {
    name,
    manifestPath,
    installed,
    register: (manifestJson: string) => {
      fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
      fs.writeFileSync(manifestPath, manifestJson);
    },
  };
}

/**
 * Windows browser entry: write the manifest under ~/.byob/ and point a
 * `HKCU\...\NativeMessagingHosts\<host>` registry key at it. We don't try
 * to detect whether Chrome is actually installed (it can live in a half-
 * dozen places) — writing an unused HKCU key is harmless, so we always
 * register and let the user decide.
 */
function winBrowserEntry(name: string, manifestPath: string, regKey: string): BrowserEntry {
  return {
    name,
    manifestPath,
    installed: () => true,
    register: (manifestJson: string) => {
      fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
      fs.writeFileSync(manifestPath, manifestJson);
      // `reg add` overwrites the (Default) value with /f and creates the
      // key if it doesn't exist. Quotes around manifestPath handle spaces
      // (e.g. `C:\Users\Some User\.byob\...`).
      execSync(
        `reg add "${regKey}" /ve /t REG_SZ /d "${manifestPath}" /f`,
        { stdio: 'pipe' },
      );
    },
  };
}

interface InstallOptions {
  dev?: boolean;
  skipBuild?: boolean;
  repoRoot: string;
}

/**
 * Generate ~/.byob/extension-key.pem if it does not exist. Returns the
 * SPKI-DER public key as base64. Pure node — no openssl on PATH required,
 * which matters on Windows where openssl isn't shipped.
 */
function ensureExtensionKey(): string {
  if (!fs.existsSync(PEM_PATH)) {
    console.log(`Generating extension key → ${PEM_PATH}`);
    fs.mkdirSync(path.dirname(PEM_PATH), { recursive: true, mode: 0o700 });
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    // PKCS#1 PEM is what `openssl genrsa` historically wrote, kept for
    // compatibility with any PEM_PATH from a pre-Windows install.
    const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }) as string;
    fs.writeFileSync(PEM_PATH, pem, { mode: 0o600 });
    if (!IS_WIN) fs.chmodSync(PEM_PATH, 0o600);
    console.log('  ✓ generated (mode 0600)');
  }
  // Re-derive the SPKI-DER public key from the private PEM every install
  // run — works regardless of how the PEM was originally created.
  const priv = crypto.createPrivateKey({
    key: fs.readFileSync(PEM_PATH),
    format: 'pem',
  });
  const pub = crypto.createPublicKey(priv);
  const spkiDer = pub.export({ type: 'spki', format: 'der' }) as Buffer;
  return spkiDer.toString('base64');
}

/**
 * Pipe `text` into the system clipboard.
 * - macOS: `pbcopy`
 * - Windows: `clip` (built-in, reads stdin)
 * - Linux: silent no-op (no universal clipboard tool).
 */
function copyToClipboard(text: string): boolean {
  try {
    if (IS_MAC) {
      const r = spawnSync('pbcopy', [], { input: text, stdio: ['pipe', 'ignore', 'ignore'] });
      return r.status === 0;
    }
    if (IS_WIN) {
      const r = spawnSync('clip', [], { input: text, stdio: ['pipe', 'ignore', 'ignore'] });
      return r.status === 0;
    }
    return false;
  } catch {
    return false;
  }
}

/** Build the extension via WXT — wxt.config.ts will read the same .pem we just wrote. */
function buildExtension(repoRoot: string): string {
  const extDir = path.join(repoRoot, 'packages/extension');
  if (!fs.existsSync(path.join(extDir, 'package.json'))) {
    throw new Error(
      `extension package not found at ${extDir}.\n` +
        'Are you running `byob install` from inside the byob repo?',
    );
  }
  console.log('Building extension (WXT)...');
  execSync('bun run build', { cwd: extDir, stdio: 'inherit' });
  const outDir = path.join(extDir, 'output/chrome-mv3');
  if (!fs.existsSync(outDir)) {
    throw new Error(`extension build did not produce ${outDir}`);
  }
  return outDir;
}

/** Build the per-platform launcher script body. */
function buildLauncherBody(opts: InstallOptions): string {
  const nodeBin = process.execPath;
  const nodeDir = path.dirname(nodeBin);
  const bridgeEntryAbs = path.join(opts.repoRoot, 'packages/bridge/bin/byob-bridge.ts');
  const tsxBinAbs = path.join(
    opts.repoRoot,
    'packages/bridge/node_modules/.bin',
    IS_WIN ? 'tsx.cmd' : 'tsx',
  );

  if (IS_WIN) {
    // .cmd batch file. PATH prepend so spawned children find node.exe.
    // %* forwards stdio handles + any args Chrome passes to the NM host.
    if (opts.dev) {
      return [
        '@echo off',
        `set "PATH=${nodeDir};%PATH%"`,
        `"${tsxBinAbs}" "${bridgeEntryAbs}" %*`,
      ].join('\r\n') + '\r\n';
    }
    return [
      '@echo off',
      `set "PATH=${nodeDir};%PATH%"`,
      `"${nodeBin}" "${bridgeEntryAbs}" %*`,
    ].join('\r\n') + '\r\n';
  }

  if (opts.dev) {
    return `#!/bin/sh
export PATH="${nodeDir}:$PATH"
exec "${tsxBinAbs}" "${bridgeEntryAbs}" "$@"
`;
  }
  return `#!/bin/sh
export PATH="${nodeDir}:$PATH"
exec "${nodeBin}" "${bridgeEntryAbs}" "$@"
`;
}

export async function install(opts: InstallOptions): Promise<void> {
  if (!IS_WIN) process.umask(0o077); // umask is meaningless on Windows

  // 1. dirs
  fs.mkdirSync(BYOB_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(BRIDGES_DIR, { recursive: true, mode: 0o700 });

  // 2. key (generated once, reused forever)
  const publicKeyB64 = ensureExtensionKey();
  const extensionId = computeExtensionId(publicKeyB64);

  // 3. extension build (uses the key just generated; skip with --skip-build
  //    e.g. when re-running install after a manual build)
  let extOutputDir: string | null = null;
  if (!opts.skipBuild) extOutputDir = buildExtension(opts.repoRoot);

  // 4. launcher script. On Windows it's a .cmd, on Unix it's a #!/bin/sh.
  const launcherBody = buildLauncherBody(opts);
  fs.writeFileSync(LAUNCHER_PATH, launcherBody, { mode: IS_WIN ? 0o644 : 0o755 });

  // 5. NM manifests per browser. On Win this writes a JSON + a registry
  //    key; on Unix it writes the JSON into the browser's NM dir.
  const manifest = {
    name: NATIVE_HOST_NAME,
    description: 'byob local bridge for AI agents',
    path: LAUNCHER_PATH,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };
  const manifestJson = JSON.stringify(manifest, null, 2);

  const written: string[] = [];
  for (const b of browserEntries()) {
    if (!b.installed()) continue;
    try {
      b.register(manifestJson);
      written.push(b.name);
    } catch (err) {
      console.warn(`  ⚠ failed to register ${b.name}: ${(err as Error).message}`);
    }
  }

  // 6. language selection + user-facing summary
  lang = await askLang();

  const tsxBin = path.join(
    opts.repoRoot,
    'packages/mcp-server/node_modules/.bin',
    IS_WIN ? 'tsx.cmd' : 'tsx',
  );
  const mcpEntry = path.join(opts.repoRoot, 'packages/mcp-server/bin/byob-mcp.ts');

  const mcpJsonObj = {
    mcpServers: {
      byob: {
        command: tsxBin,
        args: [mcpEntry],
      },
    },
  };

  // ANSI palette. Centralised here so the layout below stays scannable.
  const G = '\x1b[32m';        // green
  const Gb = '\x1b[1;32m';     // bold green
  const Yb = '\x1b[1;33m';     // bold yellow
  const C = '\x1b[36m';        // cyan
  const U = '\x1b[4m';         // underline
  const B = '\x1b[1m';         // bold
  const D = '\x1b[2m';         // dim
  const R = '\x1b[0m';         // reset
  const SUCCESS_BADGE = '\x1b[42;30m  ✓  \x1b[0m'; // green bg, black fg
  const TIMEOUT_BADGE = '\x1b[43;30m  ⏰  \x1b[0m'; // yellow bg, black fg
  const RULE = '━'.repeat(60);

  console.log('');
  console.log(`${B}${RULE}${R}`);
  console.log(`${B}${G}✓${R}${B} ${t('installDone')}${R}  ${D}— ${t('installSubtitle')}${R}`);
  console.log(`${B}${RULE}${R}`);
  console.log(`${D}Extension${R}  ${extensionId}`);
  console.log(`${D}NM hosts${R}   ${written.length === 0 ? '(none)' : written.join(', ')}`);
  if (extOutputDir) {
    const copied = copyToClipboard(extOutputDir);
    const tail = copied ? `  ${D}${t('clipboardCopied')}${R}` : '';
    console.log(`${D}Built to${R}   ${C}${B}${U}${extOutputDir}${R}${tail}`);
  }
  console.log('');

  console.log(`${B}${t('nextSteps')}${R}`);

  console.log('');
  console.log(`${G}①${R} ${B}${t('step1Title')}${R}`);
  console.log(`   ${t('step1Open')}`);
  console.log(`   ${D}•${R} ${t('step1Dev')}`);
  console.log(`   ${D}•${R} ${t('step1Load')}`);
  if (extOutputDir) console.log(`   ${D}•${R} ${t('step1Pick')} ${C}${B}${U}${extOutputDir}${R}`);

  console.log('');
  console.log(`${G}②${R} ${B}${t('step2Title')}${R}`);
  console.log(`   ${t('step2Quit')}`);
  console.log(`   ${D}${t('step2Why')}${R}`);

  console.log('');
  console.log(`${G}③${R} ${B}${t('step3Title')}${R}`);
  console.log('');
  await promptMcpRegistration(tsxBin, mcpEntry, mcpJsonObj);

  console.log('');
  console.log(`${G}④${R} ${B}${t('step4Title')}${R}`);
  console.log(`   ${D}${t('step4Hint')}${R}`);

  const online = await waitForBridge();
  console.log('');
  if (online) {
    console.log(`${SUCCESS_BADGE}  ${Gb}${t('step4OnlineHeadline')}${R}`);
    console.log('');
    console.log(`   ${D}${t('step4OnlineTry')}${R}  ${B}${t('step4OnlineExample')}${R}`);
  } else {
    console.log(`${TIMEOUT_BADGE}  ${Yb}${t('step4TimeoutHeadline')}${R}`);
    console.log('');
    console.log(`   ${B}${t('step4CommonCauses')}${R}`);
    console.log(`     1. ${t('step4Tip1')}`);
    console.log(`     2. ${t('step4Tip2')}`);
    console.log(`     3. ${t('step4Tip3')}`);
    console.log('');
    console.log(`   ${D}${t('step4DoctorRetry')}${R}`);
  }
  console.log('');
}

/**
 * After setup we don't hand the user back to the prompt — we hang here and
 * poll for an alive bridge. The user has clear feedback that the system is
 * waiting on THEM (load extension + restart Chrome), not the other way
 * around. Spinner refreshes at 10Hz, registry polled every 5th frame.
 *
 * Stays cross-platform: TTY paints a single self-rewriting line; non-TTY
 * (CI, piped) prints a dim line every 10s instead of trying to use \r.
 */
async function waitForBridge(timeoutMs = 5 * 60 * 1000): Promise<boolean> {
  const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const FRAME_MS = 100;
  const POLL_EVERY = 5; // poll registry every 5 frames (500ms)
  const isTty = process.stdout.isTTY === true;
  const start = Date.now();
  let frame = 0;
  let lastLogged = -1;

  while (Date.now() - start < timeoutMs) {
    if (frame % POLL_EVERY === 0) {
      const alive = listAliveBridges();
      if (alive.length > 0) {
        if (isTty) process.stdout.write('\r\x1b[2K');
        return true;
      }
    }
    const elapsed = Math.floor((Date.now() - start) / 1000);
    if (isTty) {
      const spin = SPINNER[frame % SPINNER.length];
      process.stdout.write(
        `\r\x1b[2K   \x1b[2m${spin} ${t('step4Waiting')}… (${elapsed}s)\x1b[0m`,
      );
    } else if (elapsed > 0 && elapsed % 10 === 0 && elapsed !== lastLogged) {
      console.log(`   ${t('step4Waiting')}… (${elapsed}s)`);
      lastLogged = elapsed;
    }
    frame++;
    await new Promise((r) => setTimeout(r, FRAME_MS));
  }
  if (isTty) process.stdout.write('\r\x1b[2K');
  return false;
}

interface ToolChoice {
  name: string;
  selected: boolean;
}

function multiSelect(items: ToolChoice[]): Promise<boolean[]> {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      resolve(items.map(() => false));
      return;
    }

    let cursor = 0;
    const selected = items.map((i) => i.selected);

    const render = (): void => {
      // Move cursor up to redraw (skip first render)
      process.stdout.write(`\x1b[${items.length}A`);
      for (let i = 0; i < items.length; i++) {
        const check = selected[i] ? '●' : '○';
        const arrow = i === cursor ? '→' : ' ';
        const highlight = i === cursor ? '\x1b[1m' : '\x1b[2m';
        process.stdout.write(`\x1b[2K   ${arrow} ${check} ${highlight}${items[i]!.name}\x1b[0m\n`);
      }
    };

    // Initial draw
    for (let i = 0; i < items.length; i++) {
      const check = selected[i] ? '●' : '○';
      const arrow = i === cursor ? '→' : ' ';
      const highlight = i === cursor ? '\x1b[1m' : '\x1b[2m';
      process.stdout.write(`   ${arrow} ${check} ${highlight}${items[i]!.name}\x1b[0m\n`);
    }

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    const onData = (key: string): void => {
      if (key === '\x03') {
        // Ctrl+C
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener('data', onData);
        process.exit(0);
      }
      if (key === ' ') {
        selected[cursor] = !selected[cursor];
        render();
      } else if (key === '\x1b[A' || key === 'k') {
        // Up
        cursor = (cursor - 1 + items.length) % items.length;
        render();
      } else if (key === '\x1b[B' || key === 'j') {
        // Down
        cursor = (cursor + 1) % items.length;
        render();
      } else if (key === '\r' || key === '\n') {
        // Enter
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener('data', onData);
        resolve(selected);
      }
    };

    process.stdin.on('data', onData);
  });
}

function mergeMcpJson(filePath: string, mcpJsonObj: { mcpServers: Record<string, unknown> }): void {
  let existing: { mcpServers?: Record<string, unknown> } = {};
  if (fs.existsSync(filePath)) {
    try {
      existing = JSON.parse(fs.readFileSync(filePath, 'utf8')) as typeof existing;
    } catch {
      // corrupted file, overwrite
    }
  }
  if (!existing.mcpServers) existing.mcpServers = {};
  Object.assign(existing.mcpServers, mcpJsonObj.mcpServers);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(existing, null, 2) + '\n');
}

function clineConfigPath(): string {
  switch (process.platform) {
    case 'darwin':
      return path.join(
        os.homedir(),
        'Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json',
      );
    case 'win32':
      return path.join(
        process.env['APPDATA'] ?? path.join(os.homedir(), 'AppData/Roaming'),
        'Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json',
      );
    default:
      return path.join(
        os.homedir(),
        '.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json',
      );
  }
}

function registerCli(name: string, cliName: string, args: string[]): boolean {
  const bin = findCli(cliName);
  if (!bin) {
    console.log(`   \x1b[31m✗\x1b[0m ${name} — \`${cliName}\` ${t('step3NotFound')}`);
    console.log(`     ${cliName} ${args.join(' ')}`);
    return false;
  }
  try {
    spawnSync(bin, args, { stdio: 'pipe' });
    console.log(`   \x1b[32m✓\x1b[0m ${name} — ${t('step3Registered')}`);
    return true;
  } catch {
    console.log(`   \x1b[31m✗\x1b[0m ${name} — ${t('step3Failed')}`);
    console.log(`     ${bin} ${args.join(' ')}`);
    return false;
  }
}

async function promptMcpRegistration(
  tsxBin: string,
  mcpEntry: string,
  mcpJsonObj: { mcpServers: Record<string, unknown> },
): Promise<void> {
  const tools: ToolChoice[] = [
    { name: 'Claude Code', selected: false },
    { name: 'Codex CLI', selected: false },
    { name: 'Cursor', selected: false },
    { name: 'Windsurf', selected: false },
    { name: 'Cline (VS Code)', selected: false },
  ];

  console.log(`   ${t('step3Choose')}`);
  console.log('');

  const selected = await multiSelect(tools);
  const anySelected = selected.some(Boolean);

  if (!anySelected) {
    console.log('');
    console.log(`   ${t('step3Skip')}`);
    console.log(`     ${tsxBin} ${mcpEntry}`);
    console.log('');
    console.log(`   ${t('step3SeeReadme')}`);
    return;
  }

  console.log('');
  let registered = 0;

  if (selected[0]) {
    if (registerCli('Claude Code', 'claude', ['mcp', 'add', 'byob', '-s', 'user', '--', tsxBin, mcpEntry])) registered++;
  }

  if (selected[1]) {
    if (registerCli('Codex CLI', 'codex', ['mcp', 'add', 'byob', '--', tsxBin, mcpEntry])) registered++;
  }

  if (selected[2]) {
    const p = path.join(os.homedir(), '.cursor', 'mcp.json');
    mergeMcpJson(p, mcpJsonObj);
    console.log(`   ✓ Cursor — ${t('step3Wrote')} ${p}`);
    registered++;
  }

  if (selected[3]) {
    const p = path.join(os.homedir(), '.codeium', 'windsurf', 'mcp_config.json');
    mergeMcpJson(p, mcpJsonObj);
    console.log(`   ✓ Windsurf — ${t('step3Wrote')} ${p}`);
    registered++;
  }

  if (selected[4]) {
    const p = clineConfigPath();
    mergeMcpJson(p, mcpJsonObj);
    console.log(`   ✓ Cline — ${t('step3Wrote')} ${p}`);
    registered++;
  }

  if (registered > 0) {
    console.log('');
    console.log(`   ${registered} ${t('step3Configured')}`);
  }
}
