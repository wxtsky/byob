import * as fs from 'node:fs';
import { REGISTRY_PATH, BYOB_DIR, socketPathFor } from './paths.js';

export interface BridgeEntry {
  deviceId: string;
  pid: number;
  socket: string;
  startedAt: number;
}

function readRaw(): BridgeEntry[] {
  try {
    if (fs.existsSync(REGISTRY_PATH)) {
      const txt = fs.readFileSync(REGISTRY_PATH, 'utf-8');
      const v = JSON.parse(txt);
      if (Array.isArray(v)) return v as BridgeEntry[];
    }
  } catch {
    // corrupt file → treat as empty
  }
  return [];
}

function writeRaw(entries: BridgeEntry[]): void {
  if (!fs.existsSync(BYOB_DIR)) fs.mkdirSync(BYOB_DIR, { recursive: true, mode: 0o700 });
  // Atomic write via tmp+rename so a reader during the write window never
  // observes a half-written file. NOTE: the read-modify-write itself is
  // still racy across concurrent bridge spawns — if two bridges both load
  // the same baseline and both write back, the later wins. Acceptable for
  // typical "one bridge at a time" use; a follow-up could add a flock.
  const tmp = `${REGISTRY_PATH}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2), { mode: 0o600 });
  // POSIX renameSync atomically overwrites; Win32 throws EEXIST when dest
  // exists, so unlink first on Windows. Wrapped in try so we don't fail on
  // first-time writes where REGISTRY_PATH doesn't exist yet.
  if (process.platform === 'win32') {
    try {
      fs.unlinkSync(REGISTRY_PATH);
    } catch {
      // didn't exist — fine
    }
  }
  fs.renameSync(tmp, REGISTRY_PATH);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function registerBridge(entry: Omit<BridgeEntry, 'startedAt'>): void {
  const filtered = readRaw().filter((e) => e.deviceId !== entry.deviceId);
  filtered.push({ ...entry, startedAt: Date.now() });
  writeRaw(filtered);
}

export function unregisterBridge(deviceId: string, ownerPid?: number): void {
  writeRaw(
    readRaw().filter(
      (e) => e.deviceId !== deviceId || (ownerPid !== undefined && e.pid !== ownerPid),
    ),
  );
}

export function listAliveBridges(): BridgeEntry[] {
  const all = readRaw();
  const entries = all.filter((e) => isProcessAlive(e.pid));
  // Compact: persist only the alive ones if anything was pruned
  if (entries.length !== all.length) writeRaw(entries);
  return entries;
}

export { socketPathFor };
