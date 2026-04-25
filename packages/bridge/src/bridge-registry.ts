import * as fs from 'node:fs';
import { REGISTRY_PATH, DOKO_DIR, socketPathFor } from './paths.js';

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
  if (!fs.existsSync(DOKO_DIR)) fs.mkdirSync(DOKO_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(entries, null, 2), { mode: 0o600 });
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

export function unregisterBridge(deviceId: string): void {
  writeRaw(readRaw().filter((e) => e.deviceId !== deviceId));
}

export function listAliveBridges(): BridgeEntry[] {
  const all = readRaw();
  const entries = all.filter((e) => isProcessAlive(e.pid));
  // Compact: persist only the alive ones if anything was pruned
  if (entries.length !== all.length) writeRaw(entries);
  return entries;
}

export { socketPathFor };
