import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { LAUNCHER_PATH, BRIDGE_BUNDLE_PATH, MCP_BUNDLE_PATH } from './paths.js';
import { browserEntries } from './install/browser-entries.js';
import { jsonMcpClients, removeFromMcpJson } from './install/mcp-clients.js';

/** Best-effort unlink that reports what it did. */
function removeFile(file: string): void {
  try {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
      console.log(`removed ${file}`);
    }
  } catch (e) {
    console.log(`could not remove ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function uninstall(): void {
  if (fs.existsSync(LAUNCHER_PATH)) {
    try {
      fs.unlinkSync(LAUNCHER_PATH);
      console.log(`removed ${LAUNCHER_PATH}`);
    } catch (e) {
      // Windows: the .cmd may still be held by a running NM host process.
      // Don't let an EBUSY here abort the rest of the uninstall (registry
      // keys, manifest files, etc.) — those are still safe to clean up.
      console.log(`could not remove ${LAUNCHER_PATH}: ${e instanceof Error ? e.message : String(e)}`);
      console.log('  (close Chrome and re-run uninstall to clean up the launcher)');
    }
  }
  // Every browser setup may have written to, installed or not.
  for (const b of browserEntries()) {
    if (b.regKey) {
      // Non-zero typically means "key didn't exist" — stay silent.
      const r = spawnSync('reg', ['delete', b.regKey, '/f'], { stdio: 'pipe' });
      if (r.status === 0) console.log(`removed ${b.regKey}`);
    }
    removeFile(b.manifestPath);
  }
  // The installed single-file bridge / MCP server (default, non-dev install).
  for (const file of [BRIDGE_BUNDLE_PATH, MCP_BUNDLE_PATH]) removeFile(file);
  // Configs setup wrote for JSON-configured clients would now point at a
  // deleted file.
  for (const client of jsonMcpClients()) {
    if (removeFromMcpJson(client.file)) console.log(`removed byob from ${client.name} (${client.file})`);
  }
  console.log('');
  console.log('If you registered byob with these tools, remove it there too:');
  console.log('  claude plugin uninstall byob@byob');
  console.log('  codex mcp remove byob');
  console.log('');
  console.log('Done. Reload the extension in Chrome to drop any existing connection.');
}
