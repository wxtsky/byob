import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const BYOB_DIR = process.env.BYOB_HOME || path.join(os.homedir(), '.byob');
const REGISTRY = path.join(BYOB_DIR, 'bridges.json');
// Written by `bun run setup`; Chrome starts the bridge through it.
const LAUNCHER = path.join(BYOB_DIR, process.platform === 'win32' ? 'bridge-host.cmd' : 'bridge-host.sh');
export const BRIDGE_LOG = path.join(BYOB_DIR, 'bridge.log');

export interface BridgeInfo {
  deviceId: string;
  pid: number;
  socket: string;
  startedAt: number;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Thrown when no bridge can be picked; carries an agent-facing hint. */
export class BridgeResolveError extends Error {
  readonly code = 'bridge_not_running';
  constructor(message: string, readonly hint: string) {
    super(message);
  }
}

/**
 * Pick the live bridge to talk to. The agent can't run byob's CLI (it isn't
 * on PATH), so a failure explains itself: not set up, browser not running,
 * or which bridges to choose between.
 */
export function resolveBridge(): BridgeInfo {
  const wanted = process.env.BYOB_DEVICE_ID;

  let entries: BridgeInfo[] = [];
  try {
    entries = JSON.parse(fs.readFileSync(REGISTRY, 'utf-8')) as BridgeInfo[];
  } catch {
    entries = [];
  }

  const live = entries.filter((e) => alive(e.pid));

  if (live.length === 0) {
    if (!fs.existsSync(LAUNCHER)) {
      throw new BridgeResolveError(
        "byob isn't set up on this machine.",
        'Tell the user to run `bun run setup` in their byob checkout, then load the extension and restart Chrome.',
      );
    }
    throw new BridgeResolveError(
      'No live byob bridge: Chrome isn\'t running, or the byob extension is disabled / not loaded.',
      'Ask the user to open Chrome and check that byob is enabled in chrome://extensions, then retry.',
    );
  }

  if (wanted) {
    const m = live.find((e) => e.deviceId === wanted);
    if (!m) {
      throw new BridgeResolveError(
        `BYOB_DEVICE_ID=${wanted} not found among live bridges: ${live.map((e) => e.deviceId).join(', ')}`,
        'Fix BYOB_DEVICE_ID in the MCP server environment, or unset it.',
      );
    }
    return m;
  }

  if (live.length > 1) {
    throw new BridgeResolveError(
      'Multiple browsers are running byob:\n' + live.map((e) => `  ${e.deviceId} (pid ${e.pid})`).join('\n'),
      'Set BYOB_DEVICE_ID in the MCP server environment to choose one.',
    );
  }

  return live[0]!;
}
