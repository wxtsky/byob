/**
 * End-to-end: handing a tab to the user (browser_wait {user}).
 * Run: BYOB_E2E=1 bun test e2e
 *
 * The answer itself comes from extension UI (toolbar popup / notification)
 * that no MCP or bridge route can reach — by design — so these cover what
 * the agent sees: pending, tab closed, policy-denied tabs. Answering and
 * the pause switch are covered by the unit tests in
 * packages/extension/lib/__tests__/toolbar.test.ts.
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

const tabOf = (text: string): number => Number(/Tab (\d+)/.exec(text)![1]);

describe.skipIf(!RUN)('byob e2e: handoff', () => {
  beforeAll(async () => { e = await startE2E(); }, 180_000);
  afterAll(async () => { await e?.close(); });

  test('an unanswered handoff comes back as pending, not as an error', async () => {
    const nav = await ok('browser_navigate', { url: `${e.origin}/form.html` });
    const r = await e.call('browser_wait', { user: 'Sign in, then click Done', timeoutSec: 1 });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('Still waiting for the user');
    expect(r.text).toContain(`tab ${tabOf(nav.text)}`);
    // Asking again picks up the same request instead of failing.
    const again = await e.call('browser_wait', { user: 'Sign in, then click Done', timeoutSec: 1 });
    expect(again.text).toContain('Still waiting for the user');
  }, T);

  test('user waits take no other condition', async () => {
    const r = await e.call('browser_wait', { user: 'Do it', text: 'x', timeoutSec: 1 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('invalid_argument');
  }, T);

  test('closing the tab ends the wait', async () => {
    const nav = await ok('browser_navigate', { url: `${e.origin}/page2.html`, newTab: true });
    const tabId = tabOf(nav.text);
    const waiting = e.call('browser_wait', { user: 'Solve the CAPTCHA', tabId, timeoutSec: 30 });
    await Bun.sleep(500);
    await ok('browser_tabs', { action: 'close', tabId });
    const r = await waiting;
    expect(r.isError).toBe(false);
    expect(r.text).toContain('The user closed the tab');
  }, T);

  // Last: the deny entry stays for the rest of the run.
  test('works on a tab the site policy keeps byob out of, without naming it', async () => {
    const nav = await ok('browser_navigate', { url: `${e.crossOrigin}/page2.html`, newTab: true });
    const tabId = tabOf(nav.text);
    expect((await e.policy({ deniedDomains: ['localhost'] })).status).toBe(200);
    expect((await e.call('browser_snapshot', { tabId })).text).toContain('url_forbidden');
    const r = await e.call('browser_wait', { user: 'Sign in here, then click Done', tabId, timeoutSec: 1 });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('Still waiting for the user');
    expect(r.text).not.toContain('localhost');
  }, T);
});
