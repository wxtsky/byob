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

export function mergeMcpJson(filePath: string, mcpJsonObj: { mcpServers: Record<string, unknown> }): void {
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
  const r = spawnSync(bin, args, { stdio: 'pipe', shell: IS_WIN });
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

export async function promptMcpRegistration(
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
