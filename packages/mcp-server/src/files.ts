/** Where byob writes screenshots, PDFs and oversized outputs. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const BYOB_DIR = process.env.BYOB_HOME || path.join(os.homedir(), '.byob');

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** Write a base64 payload; `savePath` must be absolute when given. */
export function saveBase64(kind: 'screenshots' | 'pdfs', ext: string, b64: string, savePath?: string): string {
  let target: string;
  if (savePath) {
    if (!path.isAbsolute(savePath)) throw new Error(`savePath must be absolute, got: ${savePath}`);
    target = savePath;
    ensureDir(path.dirname(target));
  } else {
    const dir = path.join(BYOB_DIR, kind);
    ensureDir(dir);
    target = path.join(dir, `${stamp()}.${ext}`);
  }
  fs.writeFileSync(target, Buffer.from(b64, 'base64'), { mode: 0o600 });
  return target;
}

/** Park a large text result on disk; the model gets the head + the path. */
export function saveOutput(tool: string, text: string, ext = 'txt'): string {
  const dir = path.join(BYOB_DIR, 'outputs');
  ensureDir(dir);
  const file = path.join(dir, `${tool}-${stamp()}.${ext}`);
  fs.writeFileSync(file, text, { mode: 0o600 });
  return file;
}

/**
 * Delete files in `dir` older than `maxAgeDays`, keeping at most `keep`
 * newest. Runs once at startup so ~/.byob/screenshots doesn't grow forever.
 */
export function pruneDir(dir: string, maxAgeDays: number, keep: number): void {
  try {
    const now = Date.now();
    const entries = fs
      .readdirSync(dir)
      .map((name) => {
        const p = path.join(dir, name);
        const st = fs.statSync(p);
        return { p, mtime: st.mtimeMs, file: st.isFile() };
      })
      .filter((e) => e.file)
      .sort((a, b) => b.mtime - a.mtime);
    entries.forEach((e, i) => {
      if (i >= keep || now - e.mtime > maxAgeDays * 86_400_000) fs.rmSync(e.p, { force: true });
    });
  } catch {
    /* dir missing — nothing to prune */
  }
}

/** Opt-in (BYOB_KEEP_DAYS=N): never delete a user's files unasked. */
export function pruneOutputs(): void {
  if (!process.env.BYOB_KEEP_DAYS) return;
  const days = Number(process.env.BYOB_KEEP_DAYS);
  if (!Number.isFinite(days) || days <= 0) return;
  for (const kind of ['screenshots', 'outputs', 'pdfs']) pruneDir(path.join(BYOB_DIR, kind), days, 500);
}
