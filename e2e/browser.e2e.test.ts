/**
 * End-to-end: real Chrome for Testing + byob extension + bridge + MCP server.
 * Run: BYOB_E2E=1 bun test e2e   (BYOB_E2E_HEADED=1 to watch)
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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

  // What the model actually reads per turn: name + description + schema.
  const defSize = (tools: Awaited<ReturnType<E2E['listTools']>>) =>
    tools.reduce((a, t) => a + t.name.length + (t.description ?? '').length + JSON.stringify(t.inputSchema).length, 0);

  test('tool surface is compact: core tools only by default', async () => {
    const tools = await e.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toContain('browser_snapshot');
    expect(names).toContain('browser_batch');
    expect(names).toContain('browser_enable_tools');
    expect(names).not.toContain('browser_network');
    for (const n of ['browser_evaluate', 'browser_fetch']) expect(names).toContain(n);
    expect(names).not.toContain('browser_userscript');
    console.log(`core tools: ${names.length}, model-visible definition chars: ${defSize(tools)}`);
    expect(defSize(tools)).toBeLessThanOrEqual(18_000);
  }, T);

  test('navigate opens a background tab and becomes the working tab', async () => {
    const r = await ok('browser_navigate', { url: `${e.origin}/form.html` });
    expect(r.text).toContain('Opened new tab');
    const tabs = await ok('browser_tabs');
    expect(tabs.text).toMatch(/▶ \[\d+\] Form fixture .*working/);
  }, T);

  test('extra tools appear on demand (list_changed) and work', async () => {
    const hidden = await e.call('browser_batch', { steps: [{ tool: 'inspect', args: { selector: '#name' } }] });
    expect(hidden.isError).toBe(true);
    expect(hidden.text).toContain('call browser_enable_tools');
    const changesBefore = e.toolListChanges();
    expect((await ok('browser_enable_tools', { groups: ['inspect'] })).text).toContain('Enabled browser_inspect');
    expect((await e.listTools()).map((t) => t.name)).toContain('browser_inspect');
    const i = await ok('browser_inspect', { selector: '#name' });
    expect(i.text).toContain('old value');
    // The rest of the suite uses network / emulate.
    await ok('browser_enable_tools', {});
    const all = await e.listTools();
    for (const n of ['browser_network', 'browser_emulate', 'browser_clipboard']) expect(all.map((t) => t.name)).toContain(n);
    expect(e.toolListChanges()).toBe(changesBefore + 2);
    console.log(`all tools: ${all.length}, model-visible definition chars: ${defSize(all)}`);
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

  test('two concurrent actions on one tab run one after the other, in order', async () => {
    await ok('browser_navigate', { url: `${e.origin}/serial.html` });
    // Per-key typing into two fields at once would interleave keystrokes
    // (and steal focus) without the per-tab lock.
    const first = e.call('browser_type', { selector: '#a', text: 'x'.repeat(12), slowly: true });
    await Bun.sleep(30);
    const second = e.call('browser_type', { selector: '#b', text: 'y'.repeat(12), slowly: true });
    const [r1, r2] = await Promise.all([first, second]);
    expect([r1.isError, r2.isError]).toEqual([false, false]);
    const v = await ok('browser_evaluate', { expression: '[a.value, b.value, log.textContent].join("|")' });
    const [a, b, log] = v.text.replace(/^string: /, '').split('|');
    expect(a).toBe('x'.repeat(12));
    expect(b).toBe('y'.repeat(12));
    expect(log).toMatch(/^a+b+$/);
  }, T);

  test('shadow DOM: open and closed shadow roots are clickable by ref, exactly once', async () => {
    await ok('browser_navigate', { url: `${e.origin}/shadow.html` });
    const s = (await ok('browser_snapshot', { interactive: true })).text;
    await ok('browser_click', { ref: refOf(s, /button "Open shadow button"/), timeoutSec: 2 });
    await ok('browser_click', { ref: refOf(s, /button "Closed shadow button"/), timeoutSec: 2 });
    expect(await textOf('#out')).toBe('none open closed');
  }, T);

  test('shortcut combos report the lowercase key like a real keyboard', async () => {
    await ok('browser_navigate', { url: `${e.origin}/keys.html` });
    await ok('browser_press_key', { key: 'ControlOrMeta+K' });
    expect(await textOf('#log')).toMatch(/\bk\|KeyK\|m[01]c[01]s0/);
    expect((await ok('browser_snapshot', { interactive: true })).text).toContain('textbox "Palette search"');
    await ok('browser_type', { text: 'hello' });
    expect((await ok('browser_evaluate', { expression: 'document.getElementById("q").value' })).text).toBe('string: hello');
    await ok('browser_navigate', { url: `${e.origin}/form.html` });
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
    const sameRef = /\[ref=(e\d+)/.exec(buttons[0]!)![1]!;
    await ok('browser_click', { ref: sameRef });
    expect((await ok('browser_snapshot', { interactive: true })).text).toMatch(/Inner clicked http:\/\/127\.0\.0\.1/);
    await ok('browser_type', { selector: 'input', framePath: ['#same'], text: 'via framePath' });
    expect((await ok('browser_evaluate', { expression: 'document.querySelector("#same").contentDocument.querySelector("input").value' })).text).toBe('string: via framePath');
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

  test('read with scroll loads lazy content and restores the scroll position', async () => {
    await ok('browser_navigate', { url: `${e.origin}/lazy.html` });
    const plain = (await ok('browser_read', {})).text;
    expect(plain).not.toContain('Item 40');
    await ok('browser_scroll', { direction: 'down', amount: 300 });
    const r = (await ok('browser_read', { scroll: true })).text;
    expect(r).toContain('Item 40');
    expect((await ok('browser_evaluate', { expression: 'Math.round(scrollY)' })).text).toBe('number: 300');
  }, T);

  test('read with scroll waits for a feed that loads its next page slowly', async () => {
    await ok('browser_navigate', { url: `${e.origin}/lazy.html?delay=900` });
    const r = (await ok('browser_read', { scroll: true })).text;
    expect(r).toContain('Item 40');
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

  test('screenshot diff: 0% when unchanged, a box around what changed', async () => {
    await ok('browser_navigate', { url: `${e.origin}/diff.html` });
    await ok('browser_screenshot', {});
    const same = await ok('browser_screenshot', { diff: true });
    expect(same.text).toContain('Diff: 0% of pixels changed');
    await ok('browser_evaluate', { expression: 'document.getElementById("a").style.background = "rgb(230, 0, 90)"' });
    const d = await ok('browser_screenshot', { diff: true });
    expect(Number(/Diff: ([\d.]+)% of pixels changed/.exec(d.text)![1])).toBeGreaterThan(0);
    const [x, y, w, h] = /1\) x=(\d+) y=(\d+) (\d+)×(\d+)/.exec(d.text)!.slice(1).map(Number);
    expect([x, y, w, h]).toEqual([40, 60, 100, 50]);
    expect(d.text).not.toContain('2) x=');
    expect(d.images).toHaveLength(1);
    const el = await ok('browser_screenshot', { selector: '#a', diff: true });
    expect(el.text).toContain("Diff: can't compare");
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

  test('record: a background tab to a .webm; tab close ends it cleanly', async () => {
    await ok('browser_navigate', { url: `${e.origin}/anim.html` });
    const s = await ok('browser_record', { action: 'start', fps: 10 });
    const id = /id (rec-[0-9a-f]+)/.exec(s.text)![1]!;
    await Bun.sleep(2500);
    expect((await e.call('browser_record', { action: 'stop', id, savePath: 'relative.webm' })).isError).toBe(true);
    const out = `/tmp/byob-e2e-${Date.now()}.webm`;
    const r = await ok('browser_record', { action: 'stop', id, savePath: out });
    const m = /Saved ([\d.]+) s video of tab \d+ \((\d+) KB, (\d+) frames\) to (.+\.webm)/.exec(r.text);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThan(1);
    expect(Number(m![3])).toBeGreaterThan(5);
    const buf = fs.readFileSync(m![4]!);
    expect([...buf.subarray(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3]); // EBML
    expect(buf.length).toBeGreaterThan(2000);
    fs.rmSync(out, { force: true });

    const t = await ok('browser_navigate', { url: `${e.origin}/anim.html`, newTab: true });
    const tabId = Number(/Tab (\d+)/.exec(t.text)![1]);
    await ok('browser_record', { action: 'start', tabId });
    await Bun.sleep(1200);
    await ok('browser_tabs', { action: 'close', tabId });
    const closed = await ok('browser_record', { action: 'stop' });
    expect(closed.text).toContain('Stopped early: the tab was closed');
    fs.rmSync(/to (.+\.webm)/.exec(closed.text)![1]!, { force: true });
  }, T);

  test('network: record a reload and summarize it', async () => {
    await ok('browser_navigate', { url: `${e.origin}/form.html` });
    const r = await ok('browser_network', { action: 'record', resourceTypes: ['*'] });
    const id = /id ([0-9a-f-]+)\)/.exec(r.text)![1]!;
    await ok('browser_navigate', { action: 'reload' });
    const s = await ok('browser_network', { action: 'stop', id });
    expect(s.text).toMatch(/GET 200 http:\/\/127\.0\.0\.1:\d+\/form\.html/);
  }, T);
  test('type: masked and maxlength fields, contenteditable append', async () => {
    await ok('browser_navigate', { url: `${e.origin}/handlers.html` });
    const card = await ok('browser_type', { selector: '#card', text: '4242424242424242' });
    expect(card.text).toContain('reformatted it: "4242 4242 4242 4242"');
    const code = await ok('browser_type', { selector: '#code', text: 'ABCDEFGH' });
    expect(code.text).toContain('maxlength');
    expect((await ok('browser_evaluate', { expression: 'document.getElementById("code").value' })).text).toBe('string: ABCDE');
    await ok('browser_type', { selector: '#ce', text: '!!', clear: false });
    expect((await ok('browser_evaluate', { expression: 'document.getElementById("ce").textContent' })).text).toBe('string: Hello!!');
  }, T);

  test('find check/uncheck reads the control behind a label and verifies the result', async () => {
    await ok('browser_navigate', { url: `${e.origin}/handlers.html` });
    expect((await ok('browser_find', { text: 'Remember me', action: 'check' })).text).toContain('already checked');
    await ok('browser_find', { text: 'Remember me', action: 'uncheck' });
    expect((await ok('browser_evaluate', { expression: 'document.getElementById("rem").checked' })).text).toBe('boolean: false');
    const radio = await e.call('browser_find', { text: 'Basic plan', action: 'uncheck' });
    expect(radio.isError).toBe(true);
    expect(radio.text).toContain('cannot be unchecked');
  }, T);

  test('select a hidden native <select>; disabled options are refused', async () => {
    await ok('browser_navigate', { url: `${e.origin}/handlers.html` });
    await ok('browser_select', { selector: '#hidden-select', values: ['Medium'], timeoutSec: 1 });
    expect((await ok('browser_evaluate', { expression: 'document.getElementById("hidden-select").value' })).text).toBe('string: m');
    const dis = await e.call('browser_select', { selector: '#hidden-select', values: ['Large'] });
    expect(dis.isError).toBe(true);
    expect(dis.text).toContain('element_disabled');
  }, T);

  test('upload through a button that opens a file chooser', async () => {
    await ok('browser_navigate', { url: `${e.origin}/handlers.html` });
    const up = '/tmp/byob-e2e-chooser.txt';
    fs.writeFileSync(up, 'hi');
    const u = await ok('browser_upload_file', { selector: '#pick', paths: [up] });
    expect(u.text).toContain('through the file chooser');
    await ok('browser_wait', { text: 'byob-e2e-chooser.txt', timeoutSec: 3 });
    const none = await e.call('browser_upload_file', { selector: '#card', paths: [up] });
    expect(none.isError).toBe(true);
    expect(none.text).toContain('did not open a file chooser');
  }, T);

  test('find inside iframes with framePath (same-origin and OOPIF)', async () => {
    await ok('browser_navigate', { url: `${e.origin}/frames.html` });
    const same = await ok('browser_find', { role: 'button', name: 'Inner button', framePath: ['#same'] });
    expect(same.text).toContain('1 match(es)');
    const cross = await ok('browser_find', { text: 'Inner button', framePath: ['#cross'], action: 'click' });
    expect(cross.text).toContain('Clicked');
    expect((await ok('browser_find', { label: 'Inner field', framePath: ['#same'] })).text).toContain('1 match(es)');
  }, T);

  test('page scroll falls back to the app-shell container', async () => {
    await ok('browser_navigate', { url: `${e.origin}/shell.html` });
    const r = await ok('browser_scroll', { direction: 'down', amount: 500 });
    expect(r.text).toContain('scrolled its main container');
    expect(r.text).toContain('scrollTop=500/');
  }, T);

  test('drag refuses when both ends cannot be on screen together', async () => {
    await ok('browser_navigate', { url: `${e.origin}/dnd-far.html` });
    const d = await e.call('browser_drag', { from: { selector: '#src' }, to: { selector: '#dst' } });
    expect(d.isError).toBe(true);
    expect(d.text).toContain("can't both be on screen");
    expect(await textOf('#dnd')).toBe('none');
  }, T);

  test('network: a second intercept on the same tab is refused', async () => {
    await ok('browser_navigate', { url: `${e.origin}/form.html` });
    const i1 = await ok('browser_network', { action: 'intercept', rules: [{ urlPattern: '*/nothing-1*', action: 'block' }] });
    const id1 = /\(id ([0-9a-f-]+)\)/.exec(i1.text)![1]!;
    const i2 = await e.call('browser_network', { action: 'intercept', rules: [{ urlPattern: '*/nothing-2*', action: 'block' }] });
    expect(i2.isError).toBe(true);
    expect(i2.text).toContain(`already has intercept ${id1}`);
    await ok('browser_network', { action: 'unintercept', id: id1 });
    const i3 = await ok('browser_network', { action: 'intercept', rules: [{ urlPattern: '*/nothing-3*', action: 'block' }] });
    await ok('browser_network', { action: 'unintercept', id: /\(id ([0-9a-f-]+)\)/.exec(i3.text)![1]! });
  }, T);

  test('a "Leave site?" prompt is reported at once instead of waiting out the navigation', async () => {
    await ok('browser_navigate', { url: `${e.origin}/leave.html` });
    await ok('browser_type', { selector: '#draft', text: 'unsaved' });
    const started = Date.now();
    const nav = await e.call('browser_navigate', { url: `${e.origin}/page2.html` });
    expect(nav.isError).toBe(true);
    expect(nav.text).toContain('dialog_open');
    expect(Date.now() - started).toBeLessThan(10_000);
    await ok('browser_dialog', { action: 'accept' });
    await ok('browser_wait', { url: '*/page2.html' });
  }, T);

  test('fetch: same-origin JSON with the page, cross-origin from the extension, bodies to disk', async () => {
    await ok('browser_navigate', { url: `${e.origin}/form.html` });
    // Relative to the working tab; JSON comes back pretty-printed.
    const json = (await ok('browser_fetch', { url: '/data.json' })).text;
    expect(json).toMatch(/^200 /);
    expect(json).toContain('"name": "byob-data"');
    // From the page, cross-origin is CORS-bound — the error says what to do.
    const cors = await e.call('browser_fetch', { url: `${e.crossOrigin}/data.json` });
    expect(cors.isError).toBe(true);
    expect(cors.text).toContain('from:"extension"');
    // From the extension there is no CORS.
    expect((await ok('browser_fetch', { url: `${e.crossOrigin}/data.json`, from: 'extension' })).text).toContain('byob-data');
    // Binary bodies are summarized inline and written whole with savePath.
    const out = path.join(os.tmpdir(), `byob-fetch-${process.pid}.pdf`);
    const pdf = (await ok('browser_fetch', { url: '/report.pdf', savePath: out })).text;
    expect(pdf).toContain('binary');
    expect(fs.readFileSync(out).subarray(0, 4).toString()).toBe('%PDF');
    fs.rmSync(out, { force: true });
  }, T);

  test('read html shows credential fields as they are (redaction is off)', async () => {
    await ok('browser_navigate', { url: `${e.origin}/form.html` });
    await ok('browser_evaluate', {
      expression: `document.body.insertAdjacentHTML('beforeend', '<form id="login"><input name="username" value="alice"><input type="password" value="hunter2"><input name="note" value="hello"></form>')`,
    });
    const html = (await ok('browser_read', { selector: '#login', format: 'html' })).text;
    expect(html).toContain('hunter2');
    expect(html).toContain('alice');
    expect(html).not.toContain('[redacted]');
    expect(html).toContain('hello');
  }, T);

  test('stopping a network recording keeps the tab\'s other overrides', async () => {
    await ok('browser_navigate', { url: `${e.origin}/form.html` });
    await ok('browser_emulate', { offline: true });
    const r = await ok('browser_network', { action: 'record' });
    await ok('browser_network', { action: 'stop', id: /id ([0-9a-f-]+)\)/.exec(r.text)![1]! });
    expect((await ok('browser_evaluate', { expression: 'navigator.onLine' })).text).toBe('boolean: false');
    await ok('browser_emulate', { reset: true });
    expect((await ok('browser_evaluate', { expression: 'navigator.onLine' })).text).toBe('boolean: true');
  }, T);

  // Last: the deny entry can't be undone without a human click (by design);
  // every run starts from a fresh profile.
  test('site policy: tightening applies at once; byob cannot drive its own pages', async () => {
    const t = await e.policy({ deniedDomains: ['localhost'] });
    expect(t.status).toBe(200);
    expect(t.body.confirmed).toBe(false);
    const blocked = await e.call('browser_navigate', { url: `${e.crossOrigin}/page2.html`, newTab: true });
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toContain('url_forbidden');
    expect(blocked.text).toContain('only they can change it');
    const self = await e.call('browser_navigate', { url: `chrome-extension://${e.extensionId}/confirm.html`, newTab: true });
    expect(self.isError).toBe(true);
    expect(self.text).toContain('url_forbidden');
    const viaCall = await e.call('browser_tabs', {});
    expect(viaCall.isError).toBe(false);
    // An action that lands on a denied host must not hand its content back.
    await ok('browser_navigate', { url: `${e.origin}/form.html` });
    await ok('browser_evaluate', {
      expression: `document.body.insertAdjacentHTML('beforeend', '<a id="out" href="${e.crossOrigin}/page2.html">leave</a>')`,
    });
    const click = await ok('browser_click', { selector: '#out', snapshot: true });
    expect(click.text).toContain('snapshot:true failed');
    expect(click.text).not.toContain('Welcome to page two');
  }, T);

  test('URLs opened at once get a tab each instead of sharing the working tab', async () => {
    await ok('browser_navigate', { url: `${e.origin}/form.html`, newTab: true });
    const pages = ['page2.html', 'content.html', 'misc.html'];
    const res = await Promise.all(pages.map((p) => ok('browser_navigate', { url: `${e.origin}/${p}` })));
    const ids = res.map((r) => Number(/Tab (\d+)/.exec(r.text)![1]));
    expect(new Set(ids).size).toBe(3);
    const where = await Promise.all(ids.map((tabId) => ok('browser_evaluate', { tabId, expression: 'location.pathname' })));
    expect(where.map((w) => w.text)).toEqual(pages.map((p) => `string: /${p}`));
  }, T);
});
