import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { t } from './messages.js';
import { multiSelect, type ToolChoice } from './tty.js';

const IS_WIN = process.platform === 'win32';

export function findCli(name: string): string | null {
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
  // Direct scan. On Windows shim extension depends on the installer:
  // bun → .exe, npm → .cmd. Try .exe first (project ships bun.lock),
  // fall back to .cmd so npm-installed CLIs are still found.
  const candidates = IS_WIN ? [`${name}.exe`, `${name}.cmd`] : [name];
  for (const dir of commonDirs) {
    for (const candidate of candidates) {
      const full = path.join(dir, candidate);
      if (fs.existsSync(full)) return full;
    }
  }
  return null;
}

/** Write JSON via tmp + rename, so a crash never leaves half a config file. */
export function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  if (IS_WIN && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  fs.renameSync(tmp, filePath);
}

/**
 * Add our server to an `{ mcpServers: {...} }` config. A file that exists but
 * isn't valid JSON (comments, a trailing comma) is left alone — rewriting it
 * would drop the user's other servers — and false is returned.
 */
export function mergeMcpJson(filePath: string, mcpJsonObj: { mcpServers: Record<string, unknown> }): boolean {
  let existing: { mcpServers?: Record<string, unknown> } = {};
  if (fs.existsSync(filePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
      existing = parsed as typeof existing;
    } catch {
      return false;
    }
  }
  if (!existing.mcpServers || typeof existing.mcpServers !== 'object') existing.mcpServers = {};
  Object.assign(existing.mcpServers, mcpJsonObj.mcpServers);
  writeJsonAtomic(filePath, existing);
  return true;
}

/**
 * Remove our server from an `{ mcpServers: {...} }` config (uninstall).
 * Returns true only when an entry was removed; unparseable files are left alone.
 */
export function removeFromMcpJson(filePath: string, name = 'byob'): boolean {
  if (!fs.existsSync(filePath)) return false;
  let existing: { mcpServers?: Record<string, unknown> } | null;
  try {
    existing = JSON.parse(fs.readFileSync(filePath, 'utf8')) as typeof existing;
  } catch {
    return false;
  }
  const servers = existing?.mcpServers;
  if (!servers || typeof servers !== 'object' || !(name in servers)) return false;
  delete servers[name];
  writeJsonAtomic(filePath, existing);
  return true;
}

/** JSON-config MCP clients and where each keeps its `mcpServers`. */
export function jsonMcpClients(): Array<{ name: string; file: string }> {
  return [
    { name: 'Cursor', file: path.join(os.homedir(), '.cursor', 'mcp.json') },
    { name: 'Windsurf', file: path.join(os.homedir(), '.codeium', 'windsurf', 'mcp_config.json') },
    { name: 'Cline', file: clineConfigPath() },
  ];
}

export function clineConfigPath(): string {
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

export function registerCli(name: string, cliName: string, args: string[]): boolean {
  const bin = findCli(cliName);
  if (!bin) {
    console.log(`   \x1b[31m✗\x1b[0m ${name} — \`${cliName}\` ${t('step3NotFound')}`);
    console.log(`     ${cliName} ${args.join(' ')}`);
    return false;
  }
  // Windows: spawnSync needs shell:true to dispatch .cmd / .bat shims —
  // without it Node returns ENOENT in result.error (NOT a thrown
  // exception, so the old try/catch was useless). Symptom: registerCli
  // would silently report ✓ Registered while the CLI never saw the call.
  // status !== 0 OR result.error means the registration failed; surface
  // both clearly so the user knows to fall back to manual registration.
  // With shell:true Node joins the command line unescaped, and the MCP
  // command is now node.exe — typically under "C:\Program Files".
  const q = (s: string): string => (IS_WIN && /\s/.test(s) && !s.startsWith('"') ? `"${s}"` : s);
  const r = spawnSync(q(bin), args.map(q), { stdio: 'pipe', shell: IS_WIN });
  if (r.error || r.status !== 0) {
    console.log(`   \x1b[31m✗\x1b[0m ${name} — ${t('step3Failed')}`);
    if (r.error) console.log(`     ${r.error.message}`);
    if (r.stderr && r.stderr.length > 0) {
      console.log(`     ${r.stderr.toString().trim().slice(0, 200)}`);
    }
    console.log(`     ${bin} ${args.join(' ')}`);
    return false;
  }
  console.log(`   \x1b[32m✓\x1b[0m ${name} — ${t('step3Registered')}`);
  return true;
}

function cliJsonListHas(
  cliName: string,
  args: string[],
  field: string,
  expected: string,
): boolean {
  const bin = findCli(cliName);
  if (!bin) return false;
  const result = spawnSync(bin, args, {
    stdio: ['ignore', 'pipe', 'ignore'],
    shell: IS_WIN,
  });
  if (result.error || result.status !== 0 || !result.stdout) return false;
  try {
    const value = JSON.parse(result.stdout.toString()) as unknown;
    return (
      Array.isArray(value) &&
      value.some(
        (entry) =>
          entry !== null &&
          typeof entry === 'object' &&
          (entry as Record<string, unknown>)[field] === expected,
      )
    );
  } catch {
    return false;
  }
}

export async function promptMcpRegistration(
  pluginMarketplaceRoot: string,
  mcpCommand: string,
  mcpArgs: string[],
  mcpJsonObj: { mcpServers: Record<string, unknown> },
): Promise<void> {
  const tools: ToolChoice[] = [
    { name: 'Claude Code (plugin + Skill)', selected: false },
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
    console.log(`     ${[mcpCommand, ...mcpArgs].join(' ')}`);
    console.log('');
    console.log(`   ${t('step3SeeReadme')}`);
    return;
  }

  console.log('');
  let registered = 0;

  if (selected[0]) {
    // The plugin bundles both the control-chrome Skill and a standalone MCP
    // server, so Claude Code users no longer need a separate `mcp add`.
    // Keep setup idempotent: Claude reports an error when adding/installing an
    // entry that already exists, but re-running `bun run setup` is a normal
    // repair workflow for byob.
    const marketplaceExists = cliJsonListHas(
      'claude',
      ['plugin', 'marketplace', 'list', '--json'],
      'name',
      'byob',
    );
    const marketplaceOk = registerCli('Claude Code marketplace', 'claude', [
      'plugin',
      'marketplace',
      ...(marketplaceExists
        ? ['update', 'byob']
        : ['add', '--scope', 'user', pluginMarketplaceRoot]),
    ]);
    const pluginExists = cliJsonListHas(
      'claude',
      ['plugin', 'list', '--json'],
      'id',
      'byob@byob',
    );
    if (
      marketplaceOk &&
      registerCli('Claude Code plugin', 'claude', [
        'plugin',
        pluginExists ? 'update' : 'install',
        'byob@byob',
        '--scope',
        'user',
      ])
    ) {
      registered++;
    }
  }

  if (selected[1]) {
    if (registerCli('Codex CLI', 'codex', ['mcp', 'add', 'byob', '--', mcpCommand, ...mcpArgs])) registered++;
  }

  // selected[2..4] = Cursor, Windsurf, Cline — same order as jsonMcpClients().
  jsonMcpClients().forEach((client, i) => {
    if (!selected[i + 2]) return;
    if (mergeMcpJson(client.file, mcpJsonObj)) {
      console.log(`   \x1b[32m✓\x1b[0m ${client.name} — ${t('step3Wrote')} ${client.file}`);
      registered++;
    } else {
      console.log(`   \x1b[31m✗\x1b[0m ${client.name} — ${client.file}: ${t('step3ParseFailed')}`);
      console.log(JSON.stringify(mcpJsonObj.mcpServers, null, 2).replace(/^/gm, '     '));
    }
  });

  if (registered > 0) {
    console.log('');
    console.log(`   ${registered} ${t('step3Configured')}`);
  }
}
