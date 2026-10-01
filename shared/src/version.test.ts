import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { VERSION } from './version.js';

// A release bumps the version in several files; Claude Code only fetches a
// new plugin when plugin.json changes, so a missed spot ships nothing.
const ROOT = path.resolve(import.meta.dir, '../..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const jsonVersion = (rel: string): unknown => (JSON.parse(read(rel)) as { version?: unknown }).version;

describe('release version', () => {
  test.each([
    'package.json',
    'shared/package.json',
    'packages/bridge/package.json',
    'packages/extension/package.json',
    'packages/mcp-server/package.json',
    'plugins/byob/.claude-plugin/plugin.json',
  ])('%s matches VERSION', (rel) => {
    expect(jsonVersion(rel)).toBe(VERSION);
  });

  test('marketplace.json plugins match VERSION when they carry one', () => {
    const market = JSON.parse(read('.claude-plugin/marketplace.json')) as { plugins?: Array<{ version?: string }> };
    for (const p of market.plugins ?? []) {
      if (p.version !== undefined) expect(p.version).toBe(VERSION);
    }
  });

  test('extension manifest (wxt.config.ts) matches VERSION', () => {
    const m = /\n\s+version:\s*'([^']+)'/.exec(read('packages/extension/wxt.config.ts'));
    expect(m?.[1]).toBe(VERSION);
  });
});
