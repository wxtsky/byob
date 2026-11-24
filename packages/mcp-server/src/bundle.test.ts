import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

test('the committed plugin bundle carries no absolute build paths', () => {
  const bundle = fs.readFileSync(path.resolve(import.meta.dir, '../../../plugins/byob/servers/byob-mcp.mjs'), 'utf-8');
  expect(bundle).not.toMatch(/"(\/Users\/|\/home\/|[A-Z]:\\\\)[^"]*node_modules/);
});
