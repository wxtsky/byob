/**
 * End-to-end: downloads started by byob's actions.
 * Run: BYOB_E2E=1 bun test e2e
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { startE2E, type E2E } from './harness';

const RUN = !!process.env.BYOB_E2E;
let e: E2E;
const T = 60_000;

async function ok(name: string, args: Record<string, unknown> = {}) {
  const r = await e.call(name, args);
  if (r.isError) throw new Error(`${name} failed: ${r.text}`);
  return r;
}

const savedPath = (text: string): string => {
  const m = /→ (\/\S.*)$/m.exec(text);
  if (!m) throw new Error(`no saved path in:\n${text}`);
  return m[1]!.trim();
};

describe.skipIf(!RUN)('byob e2e: downloads', () => {
  beforeAll(async () => {
    e = await startE2E();
    await ok('browser_enable_tools', { groups: ['downloads'] });
  }, 180_000);
  afterAll(async () => { await e?.close(); });

  test('a click that downloads says so; wait returns the saved file', async () => {
    await ok('browser_navigate', { url: `${e.origin}/downloads.html` });
    const c = await ok('browser_click', { selector: '#file' });
    expect(c.text).toMatch(/→ download(ed| started:) report\.csv/);
    const w = await ok('browser_downloads', {});
    const file = savedPath(w.text);
    expect(file.startsWith(e.downloadsDir)).toBe(true);
    expect(path.basename(file)).toBe('report.csv');
    expect(fs.readFileSync(file, 'utf-8')).toBe(fs.readFileSync(path.join(import.meta.dir, 'fixtures/report.csv'), 'utf-8'));
    expect(w.text).toContain('18 B');
  }, T);

  test('a blob download made by page script', async () => {
    const c = await ok('browser_click', { selector: '#blob' });
    expect(c.text).toMatch(/→ download(ed| started:) notes\.txt/);
    const file = savedPath((await ok('browser_downloads', { action: 'wait' })).text);
    expect(fs.readFileSync(file, 'utf-8')).toBe('hello blob');
  }, T);

  test('downloads byob did not cause are never listed', async () => {
    // Another site's page downloading while byob's late window is still open
    // (the user, in another tab): its referrer names a different origin.
    const other = await ok('browser_navigate', { url: `${e.crossOrigin}/downloads.html`, newTab: true });
    const tabId = Number(/Tab (\d+)/.exec(other.text)![1]);
    await ok('browser_evaluate', { tabId, expression: 'document.getElementById("other").click()' });
    await Bun.sleep(1500);
    expect(fs.existsSync(path.join(e.downloadsDir, 'other.csv'))).toBe(true);
    const list = (await ok('browser_downloads', { action: 'list' })).text;
    expect(list).toContain('2 download(s) started by byob');
    expect(list).toContain('report.csv');
    expect(list).toContain('notes.txt');
    expect(list).not.toContain('other.csv');
    // Nothing new to wait for.
    const none = await e.call('browser_downloads', { timeoutSec: 1 });
    expect(none.isError).toBe(true);
    expect(none.text).toContain('download_not_found');
  }, T);
});
