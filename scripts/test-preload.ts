// Bun test preload: let tests import Vite-style `?raw` modules (the extension
// inlines library sources that way) and give modules that touch `chrome.*`
// at import time a minimal stand-in.
import { plugin } from 'bun';
import * as fs from 'node:fs';

const RAW_IMPORTS = ['@mozilla/readability/Readability.js'];

plugin({
  name: 'vite-raw',
  setup(build) {
    for (const spec of RAW_IMPORTS) {
      const file = Bun.resolveSync(spec, `${import.meta.dir}/../packages/extension`);
      build.module(`${spec}?raw`, () => ({
        contents: `export default ${JSON.stringify(fs.readFileSync(file, 'utf-8'))};`,
        loader: 'js',
      }));
    }
  },
});

// Any chrome.<ns>.<event> resolves to an inert event object, so modules that
// register listeners at import time load in tests regardless of which
// namespaces they touch. Tests that need behaviour install their own stub.
function inert(): unknown {
  const fn = () => undefined;
  return new Proxy(fn, {
    get: (_t, prop) => {
      if (prop === 'hasListener') return () => false;
      if (prop === 'addListener' || prop === 'removeListener') return () => {};
      if (prop === Symbol.toPrimitive) return () => '';
      return inert();
    },
    apply: () => undefined,
  });
}
const g = globalThis as { chrome?: unknown };
if (!g.chrome) g.chrome = inert();
