/**
 * Bun writes a bundled module's __filename into the output as an absolute
 * path (undici keeps one for its stack traces). Left alone, the committed
 * plugin bundle carries the builder's home directory and differs on every
 * machine — so CI's "bundle is up to date" check could never pass. Make those
 * paths relative to the repo.
 *
 *   bun scripts/strip-build-paths.ts <bundle.mjs>...
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const repo = path.resolve(import.meta.dir, '..') + path.sep;
// As it appears inside a JS string literal (backslashes escaped on Windows).
const literal = JSON.stringify(repo).slice(1, -1);

for (const file of process.argv.slice(2)) {
  const src = fs.readFileSync(file, 'utf-8');
  const out = src.split(literal).join('');
  if (out !== src) fs.writeFileSync(file, out);
}
