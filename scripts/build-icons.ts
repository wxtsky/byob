#!/usr/bin/env -S bun
// Resize assets/logo-source.png → packages/extension/public/icon/{16,32,48,128}.png
// Uses sharp (cross-platform, lanczos3 by default — clean for the small sizes).
//
// WXT auto-picks up these PNGs as the extension icons in manifest_version 3.
//
// To replace the brand: drop a new square PNG into assets/logo-source.png
// (any size ≥ 256px), then run `bun run scripts/build-icons.ts`.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const sourcePath = path.join(repoRoot, 'assets/logo-source.png');
const outDir = path.join(repoRoot, 'packages/extension/public/icon');

if (!fs.existsSync(sourcePath)) {
  console.error(`source not found: ${sourcePath}`);
  process.exit(1);
}

const sizes = [16, 32, 48, 128];
fs.mkdirSync(outDir, { recursive: true });

for (const size of sizes) {
  const outPath = path.join(outDir, `${size}.png`);
  await sharp(sourcePath)
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toFile(outPath);
  const bytes = fs.statSync(outPath).size;
  console.log(`  ✓ ${outPath}  (${bytes} bytes)`);
}
