/** browser_wait — element state, text, URL, load state, JS predicate, delay. */
import { Tools } from '@byob/shared';
import { ByobError, isByobError } from '../errors.js';
import { callOnElement, hasTarget, mainFrameLoc, resolveTarget } from '../dom/element.js';
import { evaluateIsolated } from '../dom/frames.js';
import { waitForNetworkIdle } from '../network-idle.js';
import { sleepWithSignal } from '../signal-utils.js';
import { attach, pickTab } from './_common.js';

function urlMatches(url: string, pattern: string): boolean {
  if (!pattern.includes('*')) return url.includes(pattern);
  const re = new RegExp('^' + pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  return re.test(url);
}

export async function handleWait(raw: unknown, signal: AbortSignal): Promise<unknown> {
  const p = Tools.WaitInput.parse(raw);
  const started = Date.now();
  const tabId = await pickTab(p);
  const deadline = started + p.timeoutSec * 1000;

  if (p.ms !== undefined) await sleepWithSignal(p.ms, signal);
  const wantsPage = hasTarget(p) || p.text !== undefined || p.textGone !== undefined || p.fn !== undefined;
  const session = wantsPage ? await attach(tabId, signal, 'wait') : null;

  const conditions: Array<{ label: string; check: () => Promise<boolean> }> = [];

  if (hasTarget(p)) {
    const state = p.state ?? 'visible';
    conditions.push({
      label: `${p.ref ?? p.selector} to be ${state}`,
      check: async () => {
        let el;
        try {
          el = await resolveTarget(session!, p, signal);
        } catch (e) {
          if (isByobError(e) && (e.code === 'selector_not_found' || e.code === 'stale_ref')) {
            return state === 'hidden' || state === 'detached';
          }
          throw e;
        }
        // A resolvable node may still be detached from the document, and a
        // relocated ref is a different node: neither counts as "still there".
        const connected = !el.relocated && (await callOnElement<boolean>(el, 'function () { return this.isConnected; }', [], signal).catch(() => false));
        if (state === 'attached') return connected;
        if (state === 'detached') return !connected;
        if (!connected) return state === 'hidden';
        const vis = await callOnElement<boolean>(el, `function () {
          if (!this.isConnected) return false;
          const r = this.getBoundingClientRect();
          const cs = getComputedStyle(this);
          return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
        }`, [], signal).catch(() => false);
        return state === 'visible' ? vis : !vis;
      },
    });
  }
  if (p.text !== undefined || p.textGone !== undefined) {
    const main = await mainFrameLoc(session!, signal);
    const has = async (t: string): Promise<boolean> => {
      const r = await evaluateIsolated<boolean>(session!, main,
        `(document.body ? document.body.innerText : '').includes(${JSON.stringify(t)})`, { signal });
      return !!r.value;
    };
    if (p.text !== undefined) conditions.push({ label: `text ${JSON.stringify(p.text)} to appear`, check: () => has(p.text!) });
    if (p.textGone !== undefined) conditions.push({ label: `text ${JSON.stringify(p.textGone)} to disappear`, check: async () => !(await has(p.textGone!)) });
  }
  if (p.url !== undefined) {
    conditions.push({
      label: `URL to match ${JSON.stringify(p.url)}`,
      check: async () => urlMatches((await chrome.tabs.get(tabId)).url ?? '', p.url!),
    });
  }
  if (p.load === 'load') {
    conditions.push({ label: 'page load', check: async () => (await chrome.tabs.get(tabId)).status === 'complete' });
  }
  if (p.fn !== undefined) {
    conditions.push({
      label: `fn ${p.fn.slice(0, 60)} to be truthy`,
      check: async () => {
        const r = await session!.send<{ result: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>(
          'Runtime.evaluate', { expression: p.fn, awaitPromise: true, returnByValue: true }, signal,
        );
        if (r.exceptionDetails) {
          throw new ByobError('eval_exception', `fn threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
        }
        return !!r.result.value;
      },
    });
  }

  let pending = conditions;
  for (let i = 0; pending.length; i++) {
    const next: typeof pending = [];
    for (const c of pending) if (!(await c.check())) next.push(c);
    pending = next;
    if (!pending.length) break;
    if (Date.now() >= deadline) {
      throw new ByobError('timeout', `Timed out after ${p.timeoutSec}s waiting for ${pending.map((c) => c.label).join(' and ')}.`);
    }
    await sleepWithSignal(i < 10 ? 100 : 250, signal);
  }
  if (p.load === 'networkidle') {
    const left = Math.max(1000, deadline - Date.now());
    await waitForNetworkIdle(tabId, left, signal);
  }
  const done = [
    ...conditions.map((c) => c.label),
    ...(p.load === 'networkidle' ? ['network idle'] : []),
    ...(p.ms !== undefined ? [`${p.ms}ms`] : []),
  ];
  return { tabId, waitedMs: Date.now() - started, satisfied: done };
}
