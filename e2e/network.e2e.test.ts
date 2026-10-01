/**
 * End-to-end: network recording and interception inside cross-site iframes
 * (OOPIFs), and stop {waitFor}. Run: BYOB_E2E=1 bun test e2e
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { startE2E, type E2E } from './harness';

const RUN = !!process.env.BYOB_E2E;
let e: E2E;
const T = 60_000;

async function ok(name: string, args: Record<string, unknown> = {}) {
  const r = await e.call(name, args);
  if (r.isError) throw new Error(`${name} failed: ${r.text}`);
  return r;
}

const idOf = (text: string): string => /\(id ([0-9a-f-]+)\)/.exec(text)![1]!;

/** Poll until `fn` holds (no fixed sleeps in the assertions). */
async function until(fn: () => Promise<boolean>, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await Bun.sleep(100);
  }
  throw new Error('condition not met in time');
}

const frameText = async (frame: string): Promise<string> =>
  (await ok('browser_read', { selector: '#out', framePath: [frame] })).text;

describe.skipIf(!RUN)('byob e2e: network in iframes', () => {
  beforeAll(async () => {
    e = await startE2E();
    await ok('browser_enable_tools', { groups: ['network'] });
  }, 180_000);
  afterAll(async () => { await e?.close(); });

  test('a recording captures requests made inside a cross-site iframe', async () => {
    await ok('browser_navigate', { url: `${e.origin}/net-host.html` });
    const rec = await ok('browser_network', { action: 'record', urlPattern: '*data.json*' });
    await ok('browser_click', { selector: '#go', framePath: ['#cross'] });
    const stop = await ok('browser_network', { action: 'stop', id: idOf(rec.text), waitFor: 1 });
    expect(stop.text).toMatch(/GET 200 http:\/\/localhost:\d+\/data\.json\?from=frame/);
    expect(stop.text).toContain('byob-data'); // the reply body, read from the iframe's session
  }, T);

  test('an iframe added during a recording is recorded from its first request', async () => {
    await ok('browser_navigate', { url: `${e.origin}/net-host.html` });
    const rec = await ok('browser_network', { action: 'record', urlPattern: '*from=auto*' });
    await ok('browser_click', { selector: '#add' });
    const stop = await ok('browser_network', { action: 'stop', id: idOf(rec.text), waitFor: 1 });
    expect(stop.text).toMatch(/GET 200 http:\/\/localhost:\d+\/data\.json\?from=auto/);
    // The paused-at-start iframe was resumed: it rendered its data.
    await until(async () => (await frameText('#late')).includes('loaded byob-data'));
  }, T);

  test('an intercept applies inside a cross-site iframe', async () => {
    await ok('browser_navigate', { url: `${e.origin}/net-host.html` });
    const i = await ok('browser_network', { action: 'intercept', rules: [{ urlPattern: '*data.json*', action: 'block' }] });
    await ok('browser_click', { selector: '#go', framePath: ['#cross'] });
    await until(async () => (await frameText('#cross')).includes('blocked'));
    const un = await ok('browser_network', { action: 'unintercept', id: idOf(i.text) });
    expect(un.text).toContain('rule 0: 1 hit(s)');
    // Unintercepted: the iframe's requests flow again.
    await ok('browser_click', { selector: '#go', framePath: ['#cross'] });
    await until(async () => (await frameText('#cross')).includes('loaded byob-data'));
  }, T);

  test('stop {waitFor} waits for a request that starts later', async () => {
    await ok('browser_navigate', { url: `${e.origin}/net-delay.html` });
    const rec = await ok('browser_network', { action: 'record', urlPattern: '*from=later*' });
    await ok('browser_click', { selector: '#later' });
    const stop = await ok('browser_network', { action: 'stop', id: idOf(rec.text), waitFor: 1 });
    expect(stop.text).toMatch(/Recorded 1 request/);
    expect(stop.text).toContain('byob-data');
    expect(stop.text).not.toContain('Only');
  }, T);

  test('stop {waitFor} reports what arrived when the wait runs out', async () => {
    await ok('browser_navigate', { url: `${e.origin}/net-delay.html` });
    const rec = await ok('browser_network', { action: 'record', urlPattern: '*never*' });
    const stop = await ok('browser_network', { action: 'stop', id: idOf(rec.text), waitFor: 1, timeoutSec: 1 });
    expect(stop.text).toContain('Only 0 of 1 matching request(s) finished within 1s');
  }, T);
});
