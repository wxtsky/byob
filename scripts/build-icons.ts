#!/usr/bin/env -S bun
// Render assets/logo.svg → packages/extension/public/icon/{16,32,48,128}.png
// Sharp rasterises the SVG at high density, then resamples down with lanczos3
// so all four sizes stay sharp.
//
// WXT auto-picks up these PNGs as the extension icons in manifest_version 3.
//
// To replace the brand: edit assets/logo.svg, then run
// `bun run scripts/build-icons.ts` and commit the regenerated PNGs.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const svgPath = path.join(repoRoot, 'assets/logo.svg');
const outDir = path.join(repoRoot, 'packages/extension/public/icon');

if (!fs.existsSync(svgPath)) {
  console.error(`source not found: ${svgPath}`);
  process.exit(1);
}

const svg = fs.readFileSync(svgPath);
fs.mkdirSync(outDir, { recursive: true });

const sizes = [16, 32, 48, 128];
for (const size of sizes) {
  const outPath = path.join(outDir, `${size}.png`);
  await sharp(svg, { density: 600 })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toFile(outPath);
  const bytes = fs.statSync(outPath).size;
  console.log(`  ✓ ${outPath}  (${bytes} bytes)`);
}
