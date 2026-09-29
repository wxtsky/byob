import { afterEach, describe, expect, test } from 'bun:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { leanToolList } from '../lean-schema.js';
import { registerAllTools } from './all.js';
import type { ToolProfile } from './profile.js';

const CORE = [
  'browser_tabs', 'browser_navigate', 'browser_snapshot', 'browser_find', 'browser_click', 'browser_type',
  'browser_press_key', 'browser_hover', 'browser_select', 'browser_scroll', 'browser_drag', 'browser_upload_file',
  'browser_wait', 'browser_read', 'browser_screenshot', 'browser_console', 'browser_storage', 'browser_dialog',
  'browser_batch', 'browser_enable_tools',
];
const EXTRA = ['browser_network', 'browser_emulate', 'browser_inspect', 'browser_clipboard', 'browser_download_images', 'browser_record', 'browser_evaluate'];

let clients: Client[] = [];
const evalBefore = process.env.BYOB_ALLOW_EVAL;
afterEach(async () => {
  for (const c of clients) await c.close();
  clients = [];
  if (evalBefore === undefined) delete process.env.BYOB_ALLOW_EVAL;
  else process.env.BYOB_ALLOW_EVAL = evalBefore;
});

async function connect(profile: ToolProfile) {
  process.env.BYOB_ALLOW_EVAL = '1';
  const server = new McpServer({ name: 'byob-test', version: '0' });
  registerAllTools(server, profile);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  let listChanged = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => { listChanged++; });
  await Promise.all([server.connect(leanToolList(serverSide)), client.connect(clientSide)]);
  clients.push(client);
  const list = async () => (await client.listTools()).tools;
  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text?: string }> };
  return { list, call, listChanged: () => listChanged };
}

/** What the model reads per turn: name + description + input schema. */
const size = (tools: Array<{ name: string; description?: string; inputSchema: unknown }>) =>
  tools.reduce((a, t) => a + t.name.length + (t.description ?? '').length + JSON.stringify(t.inputSchema).length, 0);

describe('tool profiles', () => {
  test('core lists the everyday tools only, in under 15k characters', async () => {
    const c = await connect('core');
    const tools = await c.list();
    expect(tools.map((t) => t.name).sort()).toEqual([...CORE].sort());
    expect(size(tools)).toBeLessThanOrEqual(15_000);
    // Boilerplate stripped from every schema.
    expect(JSON.stringify(tools)).not.toContain('$schema');
    expect(JSON.stringify(tools)).not.toContain('"additionalProperties":false');
  });

  test('full lists everything and no enable tool', async () => {
    const c = await connect('full');
    const names = (await c.list()).map((t) => t.name);
    expect(names.sort()).toEqual([...CORE.filter((n) => n !== 'browser_enable_tools'), ...EXTRA].sort());
    console.log(`tool definitions: full ${size(await c.list())} chars`);
  });

  test('browser_enable_tools adds groups with one list_changed', async () => {
    const c = await connect('core');
    const r = await c.call('browser_enable_tools', { groups: ['network', 'inspect'] });
    expect(r.isError).toBeFalsy();
    expect(r.content[0]!.text).toContain('Enabled browser_network, browser_inspect');
    await Bun.sleep(10);
    expect(c.listChanged()).toBe(1);
    const names = (await c.list()).map((t) => t.name);
    expect(names).toContain('browser_network');
    expect(names).toContain('browser_inspect');
    expect(names).not.toContain('browser_emulate');
    const again = await c.call('browser_enable_tools', { groups: ['network'] });
    expect(again.content[0]!.text).toContain('Already enabled: browser_network');
    const all = await c.call('browser_enable_tools', {});
    expect(all.content[0]!.text).toContain('browser_evaluate');
    expect((await c.list()).length).toBe(CORE.length + EXTRA.length);
  });

  test('a hidden tool is refused, directly and inside browser_batch', async () => {
    const c = await connect('core');
    const direct = await c.call('browser_emulate', { reset: true });
    expect(direct.isError).toBe(true);
    const b = await c.call('browser_batch', { steps: [{ tool: 'emulate', args: { reset: true } }] });
    expect(b.isError).toBe(true);
    expect(b.content[0]!.text).toContain('browser_emulate is not enabled — call browser_enable_tools {groups:["emulate"]} first');
    const unknown = await c.call('browser_batch', { steps: [{ tool: 'nope' }] });
    expect(unknown.content[0]!.text).toContain('unknown tool "nope"');
    expect(unknown.content[0]!.text).not.toContain('emulate');
  });
});
