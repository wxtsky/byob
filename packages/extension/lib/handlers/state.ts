/**
 * browser_console, browser_inspect, browser_evaluate, browser_storage,
 * browser_dialog, browser_clipboard, browser_emulate, browser_network.
 */
import { Tools } from '@byob/shared';
import type { CdpSession } from '../cdp.js';
import { ByobError } from '../errors.js';
import { readConsole } from '../console-buffer.js';
import { callOnElement, describeHandle, hasTarget, mainFrameLoc, resolveTarget, resolveFramePath } from '../dom/element.js';
import { evaluateIsolated, sendTo } from '../dom/frames.js';
import { getDialog, handleDialog } from '../dialog-registry.js';
import { readClipboardText, writeClipboardText } from '../clipboard.js';
import { isHostAllowedByPolicy } from '../url-guard.js';
import { resolveFrame } from '../frame-resolver.js';
import { attach, pickTab, tabSummary } from './_common.js';
import { handleGetPerformance } from './get-performance.js';
import { handleEmulateDevice } from './emulate-device.js';
import { handleStartRecordNetwork } from './start-record-network.js';
import { handleStopRecordNetwork } from './stop-record-network.js';
import { handleInterceptStart } from './intercept-start.js';
import { handleInterceptStop } from './intercept-stop.js';

/** Legacy handlers return error envelopes instead of throwing. */
function unwrap(r: unknown): Record<string, unknown> {
  const o = r as Record<string, unknown>;
  if (o && typeof o.error === 'string') throw new ByobError(o.error as never, String(o.message ?? o.error), o.hint as string | undefined);
  return o;
}

// ---------------------------------------------------------------------------

export async function handleConsole(raw: unknown, signal: AbortSignal): Promise<unknown> {
  const p = Tools.ConsoleInput.parse(raw);
  const tabId = await pickTab(p);
  // Attaching starts collection (and replays Log history) if this is the
  // first byob call on the tab.
  await attach(tabId, signal, 'read console', { allowDialog: true });
  const r = readConsole(tabId, { since: p.since, minLevel: p.level, limit: p.limit, clear: p.clear });
  return { tabId, ...r };
}

// ---------------------------------------------------------------------------

export const ELEMENT_INFO_FN = `function (styles) {
  const el = this;
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const attrs = {};
  for (const a of Array.from(el.attributes).slice(0, 30)) attrs[a.name] = a.value.length > 200 ? a.value.slice(0, 200) + '…' : a.value;
  const out = {
    tag: el.tagName.toLowerCase(),
    box: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
    visible: r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none',
    inViewport: r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth,
    enabled: !(el.disabled || el.closest('[aria-disabled="true"]')),
    focused: document.activeElement === el,
    text: (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 300),
    attributes: attrs,
  };
  if ('checked' in el) out.checked = el.checked;
  if ('value' in el && el.type !== 'password') out.value = String(el.value).slice(0, 300);
  if (styles && styles.length) { out.styles = {}; for (const s of styles) out.styles[s] = cs.getPropertyValue(s); }
  return out;
}`;

export async function handleInspect(raw: unknown, signal: AbortSignal): Promise<unknown> {
  const p = Tools.InspectInput.parse(raw);
  const tabId = await pickTab(p);
  if (p.action === 'performance') return unwrap(await handleGetPerformance({ tabId }, signal));
  const session = await attach(tabId, signal, 'inspect');
  if (!hasTarget(p)) throw new ByobError('invalid_argument', 'browser_inspect element: pass ref or selector.');
  let count: number | undefined;
  if (p.selector !== undefined) {
    const loc = await resolveFramePath(session, p.framePath, signal);
    const c = await evaluateIsolated<number>(session, loc, `document.querySelectorAll(${JSON.stringify(p.selector)}).length`, { signal });
    count = c.value;
  }
  const el = await resolveTarget(session, p, signal);
  const info = await callOnElement<Record<string, unknown>>(el, ELEMENT_INFO_FN, [p.styles ?? []], signal);
  return { tabId, element: describeHandle(el), ref: el.ref, ...(count !== undefined ? { matchCount: count } : {}), ...info };
}

// ---------------------------------------------------------------------------

function wrapExpression(code: string): { expr: string; isBody: boolean } {
  // A snippet with `return` is a function body; anything else an expression.
  return /(^|[;{}\s])return[\s;(]/.test(code) ? { expr: code, isBody: true } : { expr: code, isBody: false };
}

export async function handleEvaluate(raw: unknown, signal: AbortSignal): Promise<unknown> {
  const p = Tools.EvaluateInput.parse(raw);
  const tabId = await pickTab(p);
  const session = await attach(tabId, signal, 'evaluate');
  const { expr, isBody } = wrapExpression(p.expression);
  type Res = { result: { type: string; subtype?: string; value?: unknown; description?: string; unserializableValue?: string }; exceptionDetails?: { text?: string; lineNumber?: number; exception?: { description?: string } } };
  let res: Res;
  if (hasTarget(p)) {
    const el = await resolveTarget(session, p, signal);
    // Main world, so page globals are visible to the snippet.
    const main = await sendTo<{ object: { objectId?: string } }>(session, el.frame.sessionId, 'DOM.resolveNode', { backendNodeId: el.backendNodeId }, signal);
    const fn = isBody ? `async function () { const el = this; ${expr}\n}` : `async function () { const el = this; return (${expr}\n); }`;
    res = await sendTo<Res>(session, el.frame.sessionId, 'Runtime.callFunctionOn', {
      objectId: main.object.objectId, functionDeclaration: fn, awaitPromise: p.awaitPromise, returnByValue: true,
    }, signal);
  } else {
    // framePath → that frame's main world (page globals of the iframe).
    const frame = p.framePath?.length ? await resolveFrame(session, p.framePath, signal) : null;
    const params: Record<string, unknown> = {
      expression: isBody ? `(async () => { ${expr}\n})()` : expr,
      awaitPromise: p.awaitPromise,
      returnByValue: true,
      replMode: !isBody,
      userGesture: true,
      ...(frame ? { contextId: frame.contextId } : {}),
    };
    res = await sendTo<Res>(session, frame?.sessionId, 'Runtime.evaluate', params, signal);
  }
  if (res.exceptionDetails) {
    const d = res.exceptionDetails;
    throw new ByobError('eval_exception', d.exception?.description ?? d.text ?? 'Uncaught exception', undefined, {
      exceptionDetails: { text: d.text, lineNumber: d.lineNumber },
    });
  }
  const r = res.result;
  const value = r.value !== undefined ? r.value : r.unserializableValue ?? (r.type === 'undefined' ? undefined : r.description ?? `[${r.subtype ?? r.type}]`);
  return { tabId, valueType: r.subtype ?? r.type, value };
}

// ---------------------------------------------------------------------------

export async function handleStorage(raw: unknown, signal: AbortSignal): Promise<unknown> {
  const p = Tools.StorageInput.parse(raw);
  if (p.kind === 'cookies') {
    let url = p.url;
    if (!url && !p.domain) {
      const tabId = await pickTab(p);
      url = (await tabSummary(tabId)).url;
    }
    const filter: chrome.cookies.GetAllDetails = {};
    if (p.domain) filter.domain = p.domain;
    else if (url) filter.url = url;
    if (p.action === 'set') {
      if (!p.cookies?.length) throw new ByobError('invalid_argument', 'browser_storage set cookies: pass cookies[].');
      const done: string[] = [];
      for (const raw of p.cookies) {
        const c = Tools.CookieSetItem.parse(raw);
        const cu = c.url ?? url;
        if (!cu) throw new ByobError('invalid_argument', `cookie ${c.name}: url is required.`);
        if (!isHostAllowedByPolicy(new URL(cu).hostname)) throw new ByobError('url_forbidden', `${cu} is blocked by the host policy.`);
        const set = await chrome.cookies.set({
          url: cu, name: c.name, value: c.value, domain: c.domain, path: c.path, secure: c.secure,
          httpOnly: c.httpOnly, sameSite: c.sameSite, expirationDate: c.expirationDate,
        });
        if (!set) throw new ByobError('unknown', `Chrome rejected cookie ${c.name}: ${chrome.runtime.lastError?.message ?? 'invalid attributes'}`);
        done.push(c.name);
      }
      return { kind: 'cookies', set: done };
    }
    const all = (await chrome.cookies.getAll(filter)).filter((c) => isHostAllowedByPolicy(c.domain));
    const picked = p.name ? all.filter((c) => c.name === p.name) : all;
    if (p.action === 'clear') {
      for (const c of picked) {
        const host = c.domain.replace(/^\./, '');
        await chrome.cookies.remove({ url: `http${c.secure ? 's' : ''}://${host}${c.path}`, name: c.name, storeId: c.storeId });
      }
      return { kind: 'cookies', cleared: picked.length };
    }
    return {
      kind: 'cookies',
      scope: p.domain ?? url,
      cookies: picked.map((c) => ({
        name: c.name, value: c.value, domain: c.domain, path: c.path, expires: c.expirationDate,
        httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite,
      })),
    };
  }
  const tabId = await pickTab(p);
  const session = await attach(tabId, signal, 'read storage');
  const loc = p.framePath?.length ? await resolveFramePath(session, p.framePath, signal) : await mainFrameLoc(session, signal);
  const area = p.kind === 'local' ? 'localStorage' : 'sessionStorage';
  const code =
    p.action === 'set'
      ? `(() => { const s = ${area}; const items = ${JSON.stringify(p.items ?? {})}; for (const k in items) s.setItem(k, items[k]); return Object.keys(items); })()`
      : p.action === 'clear'
        ? `(() => { const s = ${area}; ${p.name ? `s.removeItem(${JSON.stringify(p.name)}); return 1;` : 'const n = s.length; s.clear(); return n;'} })()`
        : `(() => { const s = ${area}; const out = {}; ${p.name ? `const v = s.getItem(${JSON.stringify(p.name)}); if (v !== null) out[${JSON.stringify(p.name)}] = v;` : 'for (let i = 0; i < s.length; i++) { const k = s.key(i); out[k] = s.getItem(k); }'} return { origin: location.origin, items: out }; })()`;
  const r = await evaluateIsolated<unknown>(session, loc, code, { signal });
  if (p.action === 'set') return { kind: p.kind, tabId, set: r.value };
  if (p.action === 'clear') return { kind: p.kind, tabId, cleared: r.value };
  return { kind: p.kind, tabId, ...(r.value as object) };
}

// ---------------------------------------------------------------------------

export async function handleDialogTool(raw: unknown, signal: AbortSignal): Promise<unknown> {
  const p = Tools.DialogInput.parse(raw);
  const tabId = await pickTab(p);
  void signal;
  const d = getDialog(tabId);
  if (p.action === 'get') return { tabId, dialog: d ?? null };
  if (!d) throw new ByobError('dialog_not_found', 'No JavaScript dialog is open in this tab.');
  await handleDialog(tabId, p.action, p.promptText);
  return { tabId, handled: p.action, dialog: d };
}

export async function handleClipboard(raw: unknown): Promise<unknown> {
  const p = Tools.ClipboardInput.parse(raw);
  try {
    if (p.action === 'read') return { text: await readClipboardText() };
    if (p.text === undefined) throw new ByobError('invalid_argument', 'browser_clipboard write: pass text.');
    await writeClipboardText(p.text);
    return { written: p.text.length };
  } catch (e) {
    if (e instanceof ByobError) throw e;
    throw new ByobError('clipboard_failed', e instanceof Error ? e.message : String(e));
  }
}

// ---------------------------------------------------------------------------

async function emulateExtras(session: CdpSession, p: Tools.EmulateInputT, signal: AbortSignal): Promise<string[]> {
  const applied: string[] = [];
  const s = <T>(m: string, params: Record<string, unknown> = {}): Promise<T> => session.send<T>(m, params, signal);
  if (p.reset) {
    await s('Emulation.clearDeviceMetricsOverride').catch(() => {});
    await s('Emulation.setUserAgentOverride', { userAgent: '' }).catch(() => {});
    await s('Emulation.setEmulatedMedia', { features: [] }).catch(() => {});
    await s('Emulation.clearGeolocationOverride').catch(() => {});
    await s('Emulation.setTimezoneOverride', { timezoneId: '' }).catch(() => {});
    await s('Emulation.setLocaleOverride', {}).catch(() => {});
    await s('Emulation.setTouchEmulationEnabled', { enabled: false }).catch(() => {});
    await s('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }).catch(() => {});
    await s('Network.setExtraHTTPHeaders', { headers: {} }).catch(() => {});
    return ['all overrides cleared'];
  }
  const media: Array<{ name: string; value: string }> = [];
  if (p.colorScheme) media.push({ name: 'prefers-color-scheme', value: p.colorScheme });
  if (p.reducedMotion !== undefined) media.push({ name: 'prefers-reduced-motion', value: p.reducedMotion ? 'reduce' : 'no-preference' });
  if (media.length) {
    await s('Emulation.setEmulatedMedia', { features: media });
    applied.push(...media.map((m) => `${m.name}: ${m.value}`));
  }
  if (p.geolocation) {
    await s('Emulation.setGeolocationOverride', { ...p.geolocation, accuracy: p.geolocation.accuracy ?? 50 });
    applied.push(`geolocation ${p.geolocation.latitude},${p.geolocation.longitude}`);
  }
  if (p.timezone) {
    await s('Emulation.setTimezoneOverride', { timezoneId: p.timezone });
    applied.push(`timezone ${p.timezone}`);
  }
  if (p.locale) {
    await s('Emulation.setLocaleOverride', { locale: p.locale });
    applied.push(`locale ${p.locale}`);
  }
  if (p.offline !== undefined || p.headers) await s('Network.enable');
  if (p.offline !== undefined) {
    await s('Network.emulateNetworkConditions', { offline: p.offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    applied.push(p.offline ? 'offline' : 'online');
  }
  if (p.headers) {
    await s('Network.setExtraHTTPHeaders', { headers: p.headers });
    applied.push(`headers ${Object.keys(p.headers).join(', ')}`);
  }
  return applied;
}

export async function handleEmulate(raw: unknown, signal: AbortSignal): Promise<unknown> {
  const p = Tools.EmulateInput.parse(raw);
  const tabId = await pickTab(p);
  const session = await attach(tabId, signal, 'emulate');
  const applied: string[] = [];
  if (!p.reset && (p.device || p.viewport)) {
    const r = unwrap(await handleEmulateDevice({ tabId, ...(p.device ? { preset: p.device } : { custom: p.viewport }) }, signal));
    const a = r.applied as { width: number; height: number; mobile: boolean } | null;
    applied.push(a ? `viewport ${a.width}×${a.height}${a.mobile ? ' (mobile)' : ''}` : 'viewport reset');
  }
  applied.push(...(await emulateExtras(session, p, signal)));
  if (!applied.length) throw new ByobError('invalid_argument', 'browser_emulate: nothing to apply.');
  return { tabId, applied };
}

// ---------------------------------------------------------------------------

export async function handleNetwork(raw: unknown, signal: AbortSignal): Promise<unknown> {
  const p = Tools.NetworkInput.parse(raw);
  switch (p.action) {
    case 'record': {
      const tabId = await pickTab(p);
      const r = unwrap(await handleStartRecordNetwork({
        tabId,
        ...(p.resourceTypes ? { resourceTypes: p.resourceTypes } : {}),
        ...(p.urlPattern ? { urlPattern: p.urlPattern } : {}),
        includeRequestBody: p.includeBodies,
        includeResponseBody: p.includeBodies,
        ...(p.maxRecords ? { maxRecords: p.maxRecords } : {}),
      }, signal));
      return { action: 'record', id: r.recordingId, tabId, url: r.url };
    }
    case 'stop': {
      if (!p.id) throw new ByobError('invalid_argument', 'browser_network stop: pass the id from record.');
      const r = unwrap(await handleStopRecordNetwork({ recordingId: p.id, format: p.format === 'har' ? 'har' : 'json' }, signal));
      return { action: 'stop', id: p.id, format: p.format, ...r };
    }
    case 'intercept': {
      if (!p.rules?.length) throw new ByobError('invalid_argument', 'browser_network intercept: pass rules[].');
      const tabId = await pickTab(p);
      const r = unwrap(await handleInterceptStart({ tabId, rules: p.rules }, signal));
      return { action: 'intercept', id: r.interceptId, tabId, rules: p.rules.length };
    }
    case 'unintercept': {
      if (!p.id) throw new ByobError('invalid_argument', 'browser_network unintercept: pass the id from intercept.');
      const r = unwrap(await handleInterceptStop({ interceptId: p.id }, signal));
      return { action: 'unintercept', ...r };
    }
  }
}
