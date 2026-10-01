import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { mergeMcpJson, removeFromMcpJson } from './mcp-clients.js';

const ours = { mcpServers: { byob: { command: '/usr/bin/node', args: ['/x/byob-mcp.mjs'] } } };
let dir = '';
const file = (): string => path.join(dir, 'mcp.json');
const read = (): unknown => JSON.parse(fs.readFileSync(file(), 'utf8'));

afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

function fresh(content?: string): void {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'byob-mcpjson-'));
  if (content !== undefined) fs.writeFileSync(file(), content);
}

describe('mergeMcpJson', () => {
  it('creates the file when missing', () => {
    fresh();
    expect(mergeMcpJson(file(), ours)).toBe(true);
    expect(read()).toEqual(ours);
  });

  it("keeps the user's other servers and settings", () => {
    fresh(JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'x' } } }));
    expect(mergeMcpJson(file(), ours)).toBe(true);
    expect(read()).toEqual({ theme: 'dark', mcpServers: { other: { command: 'x' }, ...ours.mcpServers } });
  });

  it('leaves a file it cannot parse untouched', () => {
    const jsonc = '{\n  // my servers\n  "mcpServers": { "other": { "command": "x" }, },\n}\n';
    fresh(jsonc);
    expect(mergeMcpJson(file(), ours)).toBe(false);
    expect(fs.readFileSync(file(), 'utf8')).toBe(jsonc);
  });
});

describe('removeFromMcpJson', () => {
  it('removes only our entry', () => {
    fresh(JSON.stringify({ mcpServers: { other: { command: 'x' }, ...ours.mcpServers } }));
    expect(removeFromMcpJson(file())).toBe(true);
    expect(read()).toEqual({ mcpServers: { other: { command: 'x' } } });
  });

  it('is a no-op when there is nothing to remove or the file is unparseable', () => {
    fresh(JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
    expect(removeFromMcpJson(file())).toBe(false);
    fs.writeFileSync(file(), '{ broken');
    expect(removeFromMcpJson(file())).toBe(false);
    expect(fs.readFileSync(file(), 'utf8')).toBe('{ broken');
  });
});
