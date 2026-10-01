/**
 * End-to-end: browser_read on PDFs and several URLs, cookie export.
 * Run: BYOB_E2E=1 bun test e2e
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { startE2E, type E2E } from './harness';

const RUN = !!process.env.BYOB_E2E;
let e: E2E;
const T = 90_000;

async function ok(name: string, args: Record<string, unknown> = {}) {
  const r = await e.call(name, args);
  if (r.isError) throw new Error(`${name} failed: ${r.text}`);
  return r;
}

const tabCount = async (): Promise<number> => Number(/^(\d+) tabs:/.exec((await ok('browser_tabs')).text)![1]);

describe.skipIf(!RUN)('byob e2e: read', () => {
  beforeAll(async () => { e = await startE2E(); }, 180_000);
  afterAll(async () => { await e?.close(); });

  test('a PDF is read as text, page by page', async () => {
    const r = (await ok('browser_read', { url: `${e.origin}/report.pdf` })).text;
    expect(r).toContain('source: pdf');
    expect(r).toContain('2 pages');
    expect(r).toContain('--- page 1 ---');
    expect(r).toContain('Revenue grew 42 percent in the third quarter.');
    expect(r).toContain('--- page 2 ---');
    expect(r).toContain('zebras');
    const f = (await ok('browser_read', { filter: 'zebras' })).text;
    expect(f).toContain('--- page 2 ---');
    expect(f).not.toContain('Revenue grew');
    expect((await ok('browser_read', { outline: true })).text).toContain('- page 1: Quarterly Report');
  }, T);

  test('several URLs in parallel: one section each, failures inline, no tabs left behind', async () => {
    const before = await tabCount();
    const r = (await ok('browser_read', {
      urls: [`${e.origin}/page2.html`, `${e.origin}/report.pdf`, 'chrome://settings', `${e.crossOrigin}/content.html`],
    })).text;
    expect(r).toContain('Read 3 of 4 page(s)');
    expect(r).toMatch(/=== 1\. http:\/\/127\.0\.0\.1:\d+\/page2\.html · Second page\n/);
    expect(r).toContain('Welcome to page two.');
    expect(r).toContain('Revenue grew 42 percent');
    expect(r).toMatch(/=== 3\. chrome:\/\/settings\nError: url_forbidden/);
    expect(r).toContain('It costs 42 dollars');
    expect(await tabCount()).toBe(before);
    const both = await e.call('browser_read', { url: `${e.origin}/page2.html`, urls: [`${e.origin}/form.html`] });
    expect(both.isError).toBe(true);
  }, T);

  test('cookies: a ready Cookie header, and a Netscape cookies.txt', async () => {
    await ok('browser_navigate', { url: `${e.origin}/misc.html` });
    const r = (await ok('browser_storage', { kind: 'cookies' })).text;
    expect(r).toMatch(/^Cookie: .*sid=abc123/m);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'byob-e2e-cookies-'));
    const jar = path.join(dir, 'cookies.txt');
    try {
      const s = (await ok('browser_storage', { kind: 'cookies', savePath: jar })).text;
      expect(s).toContain('Netscape cookies.txt');
      expect(fs.statSync(jar).mode & 0o777).toBe(0o600);
      const body = fs.readFileSync(jar, 'utf-8');
      expect(body.startsWith('# Netscape HTTP Cookie File')).toBe(true);
      expect(body).toMatch(/^127\.0\.0\.1\tFALSE\t\/\tFALSE\t\d+\tsid\tabc123$/m);
      const bad = await e.call('browser_storage', { kind: 'local', savePath: jar });
      expect(bad.isError).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, T);
});
