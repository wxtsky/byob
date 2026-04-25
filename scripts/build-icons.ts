#!/usr/bin/env -S bun
// Render assets/logo-icon.svg → packages/extension/public/icon/{16,32,48,128}.png
// Using @resvg/resvg-js (pure JS, no native deps to wrestle with).
//
// WXT auto-picks up these PNGs as the extension icons in manifest_version 3.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const svgPath = path.join(repoRoot, 'assets/logo-icon.svg');
const outDir = path.join(repoRoot, 'packages/extension/public/icon');

const sizes = [16, 32, 48, 128];
const svg = fs.readFileSync(svgPath);
fs.mkdirSync(outDir, { recursive: true });

for (const size of sizes) {
  const png = new Resvg(svg, {
    fitTo: { mode: 'width', value: size },
    background: 'transparent',
  })
    .render()
    .asPng();
  const outPath = path.join(outDir, `${size}.png`);
  fs.writeFileSync(outPath, png);
  console.log(`  ✓ ${outPath}  (${png.length} bytes)`);
}
