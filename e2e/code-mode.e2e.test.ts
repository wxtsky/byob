/**
 * End-to-end as Claude Code's Code Mode runs byob: the MCP server finds
 * CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1 in its environment and answers in JSON
 * (a script gets objects; errors carry their code).
 * Run: BYOB_E2E=1 bun test e2e
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { startE2E, type E2E } from './harness';

const RUN = !!process.env.BYOB_E2E;
let e: E2E;
const T = 60_000;

async function json(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const r = await e.call(name, args);
  if (r.isError) throw new Error(`${name} failed: ${r.text}`);
  if (r.json === undefined) throw new Error(`${name} did not answer in JSON: ${r.text.slice(0, 300)}`);
  return r.json;
}

describe.skipIf(!RUN)('byob e2e — Code Mode (JSON output)', () => {
  beforeAll(async () => { e = await startE2E({ mcpEnv: { CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: '1' } }); }, 180_000);
  afterAll(async () => { await e?.close(); });

  test('every tool is listed, each saying what it returns', async () => {
    const tools = await e.listTools();
    const names = tools.map((t) => t.name);
    for (const n of ['browser_network', 'browser_record', 'browser_userscript']) expect(names).toContain(n);
    expect(names).not.toContain('browser_enable_tools');
    for (const n of ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_fetch', 'browser_batch']) {
      expect(tools.find((t) => t.name === n)!.description).toContain('Returns ');
    }
  }, T);

  test('a page round trip in objects', async () => {
    const nav = await json('browser_navigate', { url: `${e.origin}/form.html` });
    expect(nav).toMatchObject({ opened: true, title: 'Form fixture' });
    const tabs = await json('browser_tabs');
    expect(tabs.tabs.find((t: any) => t.working).tabId).toBe(nav.tabId);
    const snap = await json('browser_snapshot', { tabId: nav.tabId, interactive: true });
    expect(snap.text).toContain('textbox "Email"');
    const find = await json('browser_find', { tabId: nav.tabId, role: 'textbox', name: 'Email' });
    const typed = await json('browser_type', { ref: find.matches[0].ref, text: 'a@b.c' });
    expect(typed).toMatchObject({ tabId: nav.tabId, summary: expect.any(String) });
    const v = await json('browser_evaluate', { ref: find.matches[0].ref, expression: '({ email: el.value })' });
    expect(v.value).toEqual({ email: 'a@b.c' });
  }, T);

  test('errors are JSON a script can branch on', async () => {
    const r = await e.call('browser_click', { selector: '#no-such-thing', timeoutSec: 1 });
    expect(r.isError).toBe(true);
    expect(r.json).toMatchObject({ error: 'selector_not_found', message: expect.any(String), hint: expect.any(String) });
  }, T);

  test('fetch hands over a JSON body parsed', async () => {
    const r = await json('browser_fetch', { url: `${e.origin}/data.json` });
    expect(r.status).toBe(200);
    expect(r.json).toEqual(JSON.parse(fs.readFileSync(path.join(import.meta.dir, 'fixtures/data.json'), 'utf-8')));
    expect(r.body).toBeUndefined();
  }, T);

  test('screenshots return their path; the image only on request', async () => {
    const s = await e.call('browser_screenshot', {});
    expect(s.images).toHaveLength(0);
    expect(fs.existsSync(s.json.path)).toBe(true);
    const inline = await e.call('browser_screenshot', { inline: true });
    expect(inline.images).toHaveLength(1);
    expect(inline.json.path).toBeString();
  }, T);

  test('URLs opened at once (Promise.all) get a tab each', async () => {
    const pages = ['page2.html', 'content.html', 'misc.html'];
    const res = await Promise.all(pages.map((p) => json('browser_navigate', { url: `${e.origin}/${p}` })));
    expect(new Set(res.map((r) => r.tabId)).size).toBe(3);
    const where = await Promise.all(res.map((r) => json('browser_evaluate', { tabId: r.tabId, expression: 'location.pathname' })));
    expect(where.map((w) => w.value)).toEqual(pages.map((p) => `/${p}`));
  }, T);

  test('batch: one object per step; a failed step makes the call an error with the steps', async () => {
    const good = await json('browser_batch', { steps: [{ tool: 'evaluate', args: { expression: '1 + 1' } }, { tool: 'tabs' }] });
    expect(good.ok).toBe(true);
    expect(good.steps[0]).toMatchObject({ tool: 'browser_evaluate', ok: true, result: { value: 2 } });
    expect(good.steps[1].result.tabs.length).toBeGreaterThan(0);
    const bad = await e.call('browser_batch', { steps: [{ tool: 'click', args: { selector: '#nope', timeoutSec: 1 } }, { tool: 'tabs' }] });
    expect(bad.isError).toBe(true);
    expect(bad.json).toMatchObject({ ok: false, skipped: 1, steps: [{ tool: 'browser_click', ok: false, error: { error: 'selector_not_found' } }] });
  }, T);

  test('network stop returns the records', async () => {
    const { tabId } = await json('browser_navigate', { url: `${e.origin}/form.html`, newTab: true });
    const rec = await json('browser_network', { action: 'record', tabId, urlPattern: '*data.json*' });
    await json('browser_evaluate', { tabId, expression: 'fetch("/data.json").then((r) => r.status)' });
    const stop = await json('browser_network', { action: 'stop', id: rec.id, waitFor: 1 });
    expect(stop.records[0]).toMatchObject({ method: 'GET', responseStatus: 200 });
    expect(stop.records[0].url).toContain('/data.json');
  }, T);

  test('a huge result keeps its shape and points to the whole JSON', async () => {
    const r = await json('browser_evaluate', { expression: '"z".repeat(600000)' });
    expect(r.valueType).toBe('string');
    expect(r.value.length).toBeLessThan(600_000);
    expect(fs.statSync(r._truncated.file).size).toBeGreaterThan(600_000);
  }, T);
});
