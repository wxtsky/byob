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

const noopEvent = { hasListener: () => false, addListener: () => {}, removeListener: () => {} };
const g = globalThis as { chrome?: unknown };
if (!g.chrome) {
  g.chrome = {
    tabs: { onRemoved: noopEvent, onUpdated: noopEvent, onCreated: noopEvent },
    debugger: { onDetach: noopEvent, onEvent: noopEvent },
    runtime: {},
  };
}
