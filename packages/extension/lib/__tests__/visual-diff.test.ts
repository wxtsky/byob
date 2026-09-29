import { describe, expect, it } from 'bun:test';
import { diffPixels, mergeBoxes } from '../visual-diff.js';

const W = 100;
const H = 100;
const blank = () => new Uint8ClampedArray(W * H * 4).fill(255);
function paint(img: Uint8ClampedArray<ArrayBuffer>, x: number, y: number, w: number, h: number, v = 0): Uint8ClampedArray<ArrayBuffer> {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      const i = (yy * W + xx) * 4;
      img[i] = v; img[i + 1] = v; img[i + 2] = v;
    }
  }
  return img;
}

describe('diffPixels', () => {
  it('identical images: 0%, no boxes', () => {
    expect(diffPixels(blank(), blank(), W, H)).toEqual({ changed: 0, total: W * H, percent: 0, boxes: [], regions: 0 });
  });

  it('exact boxes around separate changes, largest first', () => {
    const b = paint(paint(blank(), 20, 30, 10, 10), 70, 70, 5, 5);
    const d = diffPixels(blank(), b, W, H);
    expect(d.changed).toBe(125);
    expect(d.percent).toBeCloseTo(1.25);
    expect(d.boxes).toEqual([
      { x: 20, y: 30, w: 10, h: 10, pixels: 100 },
      { x: 70, y: 70, w: 5, h: 5, pixels: 25 },
    ]);
  });

  it('changes within the gap merge into one region', () => {
    const b = paint(paint(blank(), 10, 10, 4, 4), 22, 10, 4, 4); // 8 px apart
    const d = diffPixels(blank(), b, W, H, { gap: 16 });
    expect(d.boxes).toEqual([{ x: 10, y: 10, w: 16, h: 4, pixels: 32 }]);
  });

  it('ignores noise under the threshold (JPEG artefacts)', () => {
    const b = paint(blank(), 0, 0, W, H, 240);
    expect(diffPixels(blank(), b, W, H).changed).toBe(0);
    expect(diffPixels(blank(), b, W, H, { threshold: 8 }).changed).toBe(W * H);
  });

  it('caps the number of boxes but reports how many regions there were', () => {
    let b = blank();
    for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) b = paint(b, i * 20, j * 20, 2, 2);
    const d = diffPixels(blank(), b, W, H, { gap: 4, maxBoxes: 10 });
    expect(d.regions).toBe(25);
    expect(d.boxes).toHaveLength(10);
  });
});

describe('mergeBoxes', () => {
  it('merges transitively until stable', () => {
    const boxes = [
      { x: 0, y: 0, w: 10, h: 10, pixels: 1 },
      { x: 100, y: 0, w: 10, h: 10, pixels: 1 },
      { x: 15, y: 0, w: 10, h: 10, pixels: 1 }, // near the first
      { x: 30, y: 0, w: 70, h: 10, pixels: 1 }, // bridges to the second
    ];
    expect(mergeBoxes(boxes, 5)).toEqual([{ x: 0, y: 0, w: 110, h: 10, pixels: 4 }]);
  });
  it('keeps distant boxes apart', () => {
    const boxes = [{ x: 0, y: 0, w: 5, h: 5, pixels: 1 }, { x: 50, y: 50, w: 5, h: 5, pixels: 1 }];
    expect(mergeBoxes(boxes, 5)).toHaveLength(2);
  });
});
