import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const REGISTRY = path.join(os.homedir(), '.byob', 'bridges.json');

interface Entry {
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

export function resolveBridgeSocket(): { socket: string; deviceId: string } {
  const wanted = process.env.BYOB_DEVICE_ID;

  let entries: Entry[] = [];
  try {
    entries = JSON.parse(fs.readFileSync(REGISTRY, 'utf-8')) as Entry[];
  } catch {
    entries = [];
  }

  const live = entries.filter((e) => alive(e.pid));

  if (live.length === 0) {
    throw new Error(
      'No live byob bridge.\n' +
        'Open Chrome with the byob extension enabled and try again.\n' +
        'Check status: byob doctor',
    );
  }

  if (wanted) {
    const m = live.find((e) => e.deviceId === wanted);
    if (!m) {
      throw new Error(
        `BYOB_DEVICE_ID=${wanted} not found among live bridges: ${live.map((e) => e.deviceId).join(', ')}`,
      );
    }
    return { socket: m.socket, deviceId: m.deviceId };
  }

  if (live.length > 1) {
    throw new Error(
      'Multiple live bridges found. Set BYOB_DEVICE_ID env to choose:\n' +
        live.map((e) => `  ${e.deviceId} (pid ${e.pid})`).join('\n'),
    );
  }

  return { socket: live[0]!.socket, deviceId: live[0]!.deviceId };
}
