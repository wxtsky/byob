/**
 * End-to-end: real Chrome for Testing + byob extension + bridge + MCP server.
 * Run: BYOB_E2E=1 bun test e2e   (BYOB_E2E_HEADED=1 to watch)
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { startE2E, type E2E } from './harness';

const RUN = !!process.env.BYOB_E2E;
let e: E2E;
const T = 60_000;

const refOf = (text: string, pattern: RegExp): string => {
  const line = text.split('\n').find((l) => pattern.test(l));
  const m = line && /\[ref=(e\d+)/.exec(line);
  if (!m) throw new Error(`no ref for ${pattern} in:\n${text}`);
  return m[1]!;
};

async function ok(name: string, args: Record<string, unknown> = {}) {
  const r = await e.call(name, args);
  if (r.isError) throw new Error(`${name} failed: ${r.text}`);
  return r;
}

async function textOf(selector: string): Promise<string> {
  const r = await ok('browser_read', { selector });
  return r.text.split('\n\n').slice(1).join('\n\n').trim();
}

describe.skipIf(!RUN)('byob e2e', () => {
  beforeAll(async () => { e = await startE2E(); }, 180_000);
  afterAll(async () => { await e?.close(); });

  test('tool surface is compact', async () => {
    const tools = await e.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toContain('browser_snapshot');
    expect(names).toContain('browser_batch');
    expect(names.length).toBeLessThanOrEqual(26);
    // What the model actually reads per turn: name + description + schema.
    const size = tools.reduce((a, t) => a + t.name.length + (t.description ?? '').length + JSON.stringify(t.inputSchema).length, 0);
    console.log(`tools: ${names.length}, model-visible definition chars: ${size}`);
    expect(size).toBeLessThan(24_000);
  }, T);

  test('navigate opens a background tab and becomes the working tab', async () => {
    const r = await ok('browser_navigate', { url: `${e.origin}/form.html` });
    expect(r.text).toContain('Opened new tab');
    const tabs = await ok('browser_tabs');
    expect(tabs.text).toMatch(/▶ \[\d+\] Form fixture .*working/);
  }, T);

  test('snapshot: refs, clickable divs, values, no label noise', async () => {
    const s = (await ok('browser_snapshot', { interactive: true })).text;
    expect(s).toMatch(/textbox "Full name" \[ref=e\d+, value="old value"\]/);
    expect(s).toMatch(/clickable "Open details more text" \[ref=e\d+\]/);
    expect(s).toMatch(/button "Disabled action" \[ref=e\d+, disabled\]/);
    expect(s).not.toMatch(/clickable "Full name"/);
  }, T);

  test('type handles plain, controlled, contenteditable fields; select; checkbox; submit', async () => {
    const s = (await ok('browser_snapshot', { interactive: true })).text;
    await ok('browser_type', { ref: refOf(s, /textbox "Full name"/), text: 'Ada Lovelace' });
    await ok('browser_type', { ref: refOf(s, /textbox "Controlled"/), text: 'ctl-val' });
    await ok('browser_type', { ref: refOf(s, /textbox "Editor"/), text: 'new editor text' });
    await ok('browser_select', { ref: refOf(s, /combobox "Color"/), values: ['Blue'] });
    await ok('browser_click', { ref: refOf(s, /checkbox "I agree"/) });
    await ok('browser_click', { ref: refOf(s, /button "Submit order"/) });
    expect(await textOf('#result')).toBe('submitted:Ada Lovelace:ctl-val::b');
    const after = (await ok('browser_snapshot', { interactive: true })).text;
    expect(after).toMatch(/textbox "Editor" \[ref=e\d+, value="new editor text"\]/);
  }, T);

  test('actionability: disabled and covered elements fail with the reason', async () => {
    const s = (await ok('browser_snapshot', { interactive: true })).text;
    const d = await e.call('browser_click', { ref: refOf(s, /Disabled action/), timeoutSec: 0.5 });
    expect(d.isError).toBe(true);
    expect(d.text).toContain('element_disabled');
    await ok('browser_click', { selector: '#showOverlay' });
    const c = await e.call('browser_click', { selector: '#covered', timeoutSec: 0.5 });
    expect(c.isError).toBe(true);
    expect(c.text).toContain('covered by <div#overlay>');
    await ok('browser_click', { x: 5, y: 5 }); // the overlay closes itself on click
    await ok('browser_click', { selector: '#covered' });
    expect(await textOf('#clicks')).toBe('covered-clicked');
  }, T);

  test('keyboard sends real key codes', async () => {
    await ok('browser_type', { selector: '#keys', text: 'aZ', slowly: true });
    await ok('browser_press_key', { selector: '#keys', key: 'Enter' });
    expect(await textOf('#keylog')).toBe('a/KeyA/65 Z/KeyZ/90 Enter/Enter/13');
  }, T);

  test('find: text / role+name / label with actions', async () => {
    const f = await ok('browser_find', { text: 'Open details', action: 'click' });
    expect(f.text).toMatch(/Clicked clickable "Open details more text"|Clicked div/);
    expect(await textOf('#result')).toBe('card-clicked');
    await ok('browser_find', { role: 'textbox', name: 'full name', action: 'fill', value: 'Grace' });
    const chk = await ok('browser_find', { label: 'I agree', action: 'check' });
    expect(chk.text).toMatch(/already checked|Clicked checkbox/);
  }, T);

  test('link navigation is reported; back/forward; stale refs are refused', async () => {
    const s = (await ok('browser_snapshot', { interactive: true })).text;
    const link = refOf(s, /link "Second page"/);
    const c = await ok('browser_click', { ref: link });
    expect(c.text).toContain('→ navigated to');
    expect(c.text).toContain('page2.html');
    const stale = await e.call('browser_click', { ref: link });
    expect(stale.isError).toBe(true);
    expect(stale.text).toContain('stale_ref');
    expect((await ok('browser_navigate', { action: 'back' })).text).toContain('Form fixture');
    expect((await ok('browser_navigate', { action: 'forward' })).text).toContain('Second page');
  }, T);

  test('batch runs a whole form in one call', async () => {
    await ok('browser_navigate', { url: `${e.origin}/form.html` });
    const b = await ok('browser_batch', {
      steps: [
        { tool: 'type', args: { selector: '#name', text: 'Batch User' } },
        { tool: 'type', args: { selector: '#ctl', text: 'ctl-batch' } },
        { tool: 'select', args: { selector: '#color', values: ['Green'] } },
        { tool: 'click', args: { selector: '#submit' } },
        { tool: 'wait', args: { text: 'submitted:' } },
      ],
    });
    expect(b.text.split('\n').filter((l) => /^\d+\. ✓/.test(l))).toHaveLength(5);
    expect(await textOf('#result')).toBe('submitted:Batch User:ctl-batch::g');
    const fail = await e.call('browser_batch', {
      steps: [{ tool: 'click', args: { selector: '#nope', timeoutSec: 0.3 } }, { tool: 'click', args: { selector: '#submit' } }],
    });
    expect(fail.isError).toBe(true);
    expect(fail.text).toContain('1 step(s) not run');
  }, T);

  test('iframes: same-origin and cross-origin (OOPIF) are snapshotted and clickable', async () => {
    await ok('browser_navigate', { url: `${e.origin}/frames.html` });
    const s = (await ok('browser_snapshot', { interactive: true })).text;
    const buttons = s.split('\n').filter((l) => l.includes('button "Inner button"'));
    expect(buttons).toHaveLength(2);
    const crossRef = /\[ref=(e\d+)/.exec(buttons[1]!)![1]!;
    await ok('browser_click', { ref: crossRef });
    const d = (await ok('browser_snapshot', { diff: true })).text;
    expect(d).toMatch(/\+ .*button "Inner clicked http:\/\/localhost:\d+"/);
    await ok('browser_click', { selector: '#inner-btn', framePath: ['#same'] });
    expect((await ok('browser_snapshot', { interactive: true })).text).toMatch(/Inner clicked http:\/\/127\.0\.0\.1/);
  }, T);

  test('SPA re-render never targets a wrong element; same-document URL change reported', async () => {
    await ok('browser_navigate', { url: `${e.origin}/spa.html` });
    const s = (await ok('browser_snapshot')).text;
    const inc = refOf(s, /button "Increment"/);
    await ok('browser_click', { ref: inc });
    const again = await e.call('browser_click', { ref: inc });
    if (again.isError) expect(again.text).toContain('stale_ref');
    else expect(again.text).toContain('re-found');
    const go = await ok('browser_find', { role: 'button', name: 'Go to settings', action: 'click' });
    expect(go.text).toContain('#settings');
  }, T);

  test('dialogs are reported and answered explicitly; new tabs are reported', async () => {
    await ok('browser_navigate', { url: `${e.origin}/dialog.html` });
    const c = await ok('browser_click', { selector: '#confirm' });
    expect(c.text).toContain('confirm dialog is open: "Delete everything?"');
    await ok('browser_dialog', { action: 'accept' });
    expect(await textOf('#out')).toBe('yes');
    const t = await ok('browser_click', { selector: '#blank' });
    expect(t.text).toMatch(/opened new tab \d+/);
  }, T);

  test('console buffer keeps history across calls', async () => {
    await ok('browser_navigate', { url: `${e.origin}/console.html` });
    await ok('browser_click', { selector: '#log' });
    await ok('browser_wait', { ms: 300 });
    const r = await ok('browser_console');
    expect(r.text).toContain('clicked 42');
    expect(r.text).toContain('WARN');
    expect(r.text).toContain('boom later');
    const again = await ok('browser_console', { level: 'error' });
    expect(again.text).toContain('boom later');
    expect(again.text).not.toContain('clicked 42');
  }, T);

  test('read: markdown, outline, filter, tables, links', async () => {
    await ok('browser_navigate', { url: `${e.origin}/content.html` });
    const md = (await ok('browser_read', { format: 'markdown' })).text;
    expect(md).toContain('# Big Title');
    expect(md).toContain('| Pro | $42 |');
    expect(md).toContain('  - nested');
    expect(md).not.toContain('hidden text');
    expect((await ok('browser_read', { outline: true })).text).toContain('  - Pricing');
    const f = (await ok('browser_read', { filter: 'dollars' })).text;
    expect(f).toContain('It costs 42 dollars');
    expect(f).not.toContain('First question');
    expect((await ok('browser_read', { format: 'links' })).text).toMatch(/a link → http:\/\/127\.0\.0\.1:\d+\/x/);
  }, T);

  test('screenshot: inline image, annotate, ifChanged, element, pdf', async () => {
    await ok('browser_navigate', { url: `${e.origin}/form.html` });
    const a = await ok('browser_screenshot', { annotate: true });
    expect(a.images).toHaveLength(1);
    expect(a.text).toContain('Labels:');
    await ok('browser_screenshot', { ifChanged: true });
    const same = await ok('browser_screenshot', { ifChanged: true });
    expect(same.text).toContain('skipped');
    const el = await ok('browser_screenshot', { selector: '#card' });
    expect(el.text).toMatch(/\(\d+×\d+/);
    const pdf = await ok('browser_screenshot', { format: 'pdf' });
    const file = /: (\/.*\.pdf)/.exec(pdf.text)![1]!;
    expect(fs.readFileSync(file).subarray(0, 4).toString()).toBe('%PDF');
  }, T);

  test('scroll, wait, upload, hover, storage, evaluate, emulate, drag', async () => {
    await ok('browser_navigate', { url: `${e.origin}/misc.html` });
    expect((await ok('browser_scroll', { selector: '#box', direction: 'down', amount: 100 })).text).toContain('scrollTop=100/');
    expect((await ok('browser_scroll', { to: 'bottom' })).text).toContain('at bottom');
    await ok('browser_click', { selector: '#reveal' });
    await ok('browser_wait', { selector: '#late' });
    const up = '/tmp/byob-e2e-upload.txt';
    fs.writeFileSync(up, 'hello');
    await ok('browser_upload_file', { selector: '#file', paths: [up] });
    expect(await textOf('#files')).toBe('byob-e2e-upload.txt');
    expect((await e.call('browser_upload_file', { selector: '#file', paths: ['relative.txt'] })).isError).toBe(true);
    await ok('browser_hover', { selector: '#hov' });
    expect(await textOf('#hov')).toBe('hovered');
    expect((await ok('browser_storage', { kind: 'local' })).text).toContain('k1 = v1');
    expect((await ok('browser_storage', { kind: 'cookies' })).text).toContain('sid=abc123');
    await ok('browser_emulate', { colorScheme: 'dark' });
    expect((await ok('browser_evaluate', { expression: 'matchMedia("(prefers-color-scheme: dark)").matches' })).text).toBe('boolean: true');
    await ok('browser_emulate', { reset: true });
    await ok('browser_navigate', { url: `${e.origin}/dnd.html` });
    expect((await ok('browser_drag', { from: { selector: '#src' }, to: { selector: '#dst' } })).text).toContain('HTML5');
    expect(await textOf('#dnd')).toBe('dropped:payload');
  }, T);

  test('network: record a reload and summarize it', async () => {
    await ok('browser_navigate', { url: `${e.origin}/form.html` });
    const r = await ok('browser_network', { action: 'record', resourceTypes: ['*'] });
    const id = /id ([0-9a-f-]+)\)/.exec(r.text)![1]!;
    await ok('browser_navigate', { action: 'reload' });
    const s = await ok('browser_network', { action: 'stop', id });
    expect(s.text).toMatch(/GET 200 http:\/\/127\.0\.0\.1:\d+\/form\.html/);
  }, T);
});
