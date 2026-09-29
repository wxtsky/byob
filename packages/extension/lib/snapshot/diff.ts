/**
 * Line diff between two snapshots (Myers, O((N+M)·D)).
 *
 * Output keeps the snapshot's own line format and prefixes changes with
 * "+"/"-". Each hunk is preceded by its nearest unchanged ancestor line so
 * the model can tell *where* in the tree the change happened.
 */

type Op = { kind: '=' | '+' | '-'; line: string };

/** Edit distance beyond which a diff is useless (and the trace would cost
 *  O(D·(N+M)) memory in the service worker). */
export const MAX_EDITS = 1500;

export function diffLines(a: string[], b: string[], maxEdits = MAX_EDITS): Op[] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const v = new Int32Array(2 * max + 2);
  // Per round only the diagonals within reach are kept, so memory is
  // O(D²) rather than O(D·(N+M)).
  const trace: Array<{ lo: number; arr: Int32Array }> = [];
  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    if (d > maxEdits) return null;
    const lo = Math.max(0, max - d - 1);
    const hi = Math.min(2 * max + 1, max + d + 1);
    trace.push({ lo, arr: v.slice(lo, hi + 1) });
    for (let k = -d; k <= d; k += 2) {
      const idx = k + max;
      let x = k === -d || (k !== d && v[idx - 1]! < v[idx + 1]!) ? v[idx + 1]! : v[idx - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[idx] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
  }
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
    const { lo, arr } = trace[d]!;
    const at = (i: number): number => arr[i - lo] ?? 0;
    const k = x - y;
    const idx = k + max;
    const prevK = k === -d || (k !== d && at(idx - 1) < at(idx + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK + max);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ kind: '=', line: a[x - 1]! });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) ops.push({ kind: '+', line: b[y - 1]! });
      else ops.push({ kind: '-', line: a[x - 1]! });
    }
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    ops.push({ kind: '=', line: a[x - 1]! });
    x--;
    y--;
  }
  return ops.reverse();
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

export interface SnapshotDiff {
  text: string;
  added: number;
  removed: number;
  unchanged: boolean;
}

/** Render a compact, ancestor-anchored diff. */
export function renderDiff(prev: string[], next: string[]): SnapshotDiff | null {
  const ops = diffLines(prev, next);
  if (!ops) return null;
  let added = 0;
  let removed = 0;
  const out: string[] = [];
  const ancestors: string[] = [];
  let lastContext = '';
  let inHunk = false;
  for (const op of ops) {
    if (op.kind === '=') {
      const ind = indentOf(op.line);
      while (ancestors.length && indentOf(ancestors[ancestors.length - 1]!) >= ind) ancestors.pop();
      ancestors.push(op.line);
      inHunk = false;
      continue;
    }
    if (!inHunk) {
      const ind = indentOf(op.line);
      const anchor = [...ancestors].reverse().find((l) => indentOf(l) < ind);
      if (anchor && anchor !== lastContext) {
        out.push(`  ${anchor}`);
        lastContext = anchor;
      }
      inHunk = true;
    }
    if (op.kind === '+') added++;
    else removed++;
    out.push(`${op.kind} ${op.line}`);
  }
  return { text: out.join('\n'), added, removed, unchanged: added === 0 && removed === 0 };
}
