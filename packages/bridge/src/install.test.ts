import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { stableNodePath } from './install.js';

describe('stableNodePath', () => {
  it('prefers Homebrew opt/ over a versioned Cellar path', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'byob-brew-'));
    const opt = path.join(root, 'opt/node/bin');
    fs.mkdirSync(opt, { recursive: true });
    fs.writeFileSync(path.join(opt, 'node'), '');
    expect(stableNodePath(path.join(root, 'Cellar/node/23.11.0/bin/node'), {})).toBe(path.join(opt, 'node'));
  });
  it('keeps an already stable path', () => {
    expect(stableNodePath('/usr/bin/node', {})).toBe('/usr/bin/node');
  });
});
