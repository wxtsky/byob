/**
 * Pixel diff of two same-size RGBA images, for browser_screenshot {diff:true}.
 *
 * A pixel counts as changed when any channel moved by more than `threshold`
 * (absorbs JPEG noise and sub-pixel antialiasing). Changed pixels are
 * grouped on a coarse grid; touching cells form a region whose box is the
 * exact extent of its changed pixels, and regions closer than `gap` are
 * merged, so one re-rendered widget reads as one box, not fifty.
 */

export interface DiffBox { x: number; y: number; w: number; h: number; pixels: number }

export interface PixelDiff {
  changed: number;
  total: number;
  /** Changed share of all pixels, 0–100. */
  percent: number;
  /** Largest first, at most `maxBoxes`. */
  boxes: DiffBox[];
  /** Regions found before the cap. */
  regions: number;
}

export interface DiffOptions {
  threshold?: number;
  cell?: number;
  gap?: number;
  maxBoxes?: number;
}

export function diffPixels(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  width: number,
  height: number,
  opts: DiffOptions = {},
): PixelDiff {
  const threshold = opts.threshold ?? 24;
  const cell = opts.cell ?? 8;
  const cols = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  // Per cell: changed-pixel count and exact extent (minX, minY, maxX, maxY).
  const count = new Int32Array(cols * rows);
  const ext = new Int32Array(cols * rows * 4);
  let changed = 0;
  for (let y = 0; y < height; y++) {
    const cy = (y / cell) | 0;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (
        Math.abs(a[i]! - b[i]!) <= threshold &&
        Math.abs(a[i + 1]! - b[i + 1]!) <= threshold &&
        Math.abs(a[i + 2]! - b[i + 2]!) <= threshold &&
        Math.abs(a[i + 3]! - b[i + 3]!) <= threshold
      ) continue;
      changed++;
      const c = cy * cols + ((x / cell) | 0);
      const e = c * 4;
      if ((count[c] = count[c]! + 1) === 1) {
        ext[e] = x; ext[e + 1] = y; ext[e + 2] = x; ext[e + 3] = y;
      } else {
        if (x < ext[e]!) ext[e] = x;
        if (x > ext[e + 2]!) ext[e + 2] = x;
        ext[e + 3] = y; // rows are scanned in order
      }
    }
  }
  const total = width * height;
  if (!changed) return { changed: 0, total, percent: 0, boxes: [], regions: 0 };

  // Connected components over changed cells (8-neighbourhood).
  const seen = new Uint8Array(cols * rows);
  const raw: DiffBox[] = [];
  const stack: number[] = [];
  for (let start = 0; start < count.length; start++) {
    if (!count[start] || seen[start]) continue;
    let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1, pixels = 0;
    seen[start] = 1;
    stack.push(start);
    while (stack.length) {
      const c = stack.pop()!;
      const e = c * 4;
      x0 = Math.min(x0, ext[e]!); y0 = Math.min(y0, ext[e + 1]!);
      x1 = Math.max(x1, ext[e + 2]!); y1 = Math.max(y1, ext[e + 3]!);
      pixels += count[c]!;
      const cx = c % cols;
      const cy = (c / cols) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          const n = ny * cols + nx;
          if (count[n] && !seen[n]) {
            seen[n] = 1;
            stack.push(n);
          }
        }
      }
    }
    raw.push({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, pixels });
  }
  const merged = mergeBoxes(raw, opts.gap ?? 16);
  merged.sort((p, q) => q.w * q.h - p.w * p.h || p.y - q.y || p.x - q.x);
  return {
    changed,
    total,
    percent: (changed / total) * 100,
    boxes: merged.slice(0, opts.maxBoxes ?? 10),
    regions: merged.length,
  };
}

/** Merge boxes that overlap or lie within `gap` px of each other, until stable. */
export function mergeBoxes(boxes: DiffBox[], gap: number): DiffBox[] {
  const out = boxes.map((b) => ({ ...b }));
  for (let merged = true; merged; ) {
    merged = false;
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const p = out[i]!;
        const q = out[j]!;
        const near =
          p.x <= q.x + q.w + gap && q.x <= p.x + p.w + gap &&
          p.y <= q.y + q.h + gap && q.y <= p.y + p.h + gap;
        if (!near) continue;
        const x = Math.min(p.x, q.x);
        const y = Math.min(p.y, q.y);
        out[i] = {
          x, y,
          w: Math.max(p.x + p.w, q.x + q.w) - x,
          h: Math.max(p.y + p.h, q.y + q.h) - y,
          pixels: p.pixels + q.pixels,
        };
        out.splice(j, 1);
        merged = true;
        j--;
      }
    }
  }
  return out;
}
