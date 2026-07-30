import { InterceptStartInput } from '@byob/shared';
import { tryAttachToTab } from '../cdp.js';
import { openOrReuse } from '../tab.js';
import { checkUrlAllowed, urlForbiddenError } from '../url-guard.js';
import { throwIfAborted } from '../signal-utils.js';
import { attachErrorEnvelope } from '../attach-error.js';
import { keepAwakeStart, keepAwakeEnd } from '../keepalive.js';
import {
  addIntercept,
  markEnded,
  type CompiledRule,
  type InterceptEntry,
} from '../intercept-registry.js';

type RuleInput = ReturnType<typeof InterceptStartInput.parse>['rules'][number];

const TEXT_LIKE_MIME = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded))/i;

export async function handleInterceptStart(
  rawParams: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const params = InterceptStartInput.parse(rawParams);
  if (params.url) {
    const guard = checkUrlAllowed(params.url);
    if (!guard.ok) return urlForbiddenError(guard.reason);
  }
  throwIfAborted(signal);

  const tab = await openOrReuse({ url: params.url, tabId: params.tabId, signal });
  const attachResult = await tryAttachToTab(tab.tabId, signal);
  const { session } = attachResult;
  if (!session) {
    if (!tab.reused) await tab.cleanup();
    return attachErrorEnvelope(attachResult);
  }

  // Compile rules
  const compiled: CompiledRule[] = params.rules.map((rule: RuleInput) => {
    const regex = rule.urlPattern
      ? globToRegex(rule.urlPattern)
      : new RegExp(rule.urlRegex!);
    const methodSet = rule.methods ? new Set(rule.methods.map((m: string) => m.toUpperCase())) : undefined;
    return {
      regex,
      methodSet,
      action: rule.action,
      block: rule.block,
      fulfill: rule.fulfill,
      modify: rule.modify,
      modifyResponse: rule.modifyResponse,
    };
  });

  // Build CDP Fetch.enable patterns. Each rule becomes one pattern with
  // requestStage='Response' iff action is modifyResponse.
  const patterns = params.rules.map((rule: RuleInput) => {
    const stage = rule.action === 'modifyResponse' ? 'Response' : 'Request';
    return {
      urlPattern: rule.urlPattern ?? '*',  // CDP filter is approximate; listener still re-checks via regex
      requestStage: stage,
    };
  });

  const interceptId = crypto.randomUUID();
  const tabInfo = await chrome.tabs.get(tab.tabId).catch(() => null);

  // KEEPALIVE: bump count BEFORE registering entry; we'll release on
  // failure or in tab-close handler.
  keepAwakeStart();

  const entry: InterceptEntry = {
    interceptId,
    tabId: tab.tabId,
    session,
    rules: compiled,
    hits: compiled.map(() => 0),
    sampleUrls: compiled.map(() => []),
    totalRequests: 0,
    startedAt: Date.now(),
    state: 'intercepting',
    listenerCleanups: [],
    tabRemovedListener: null,
    keepaliveHeld: true,  // KEEPALIVE
  };

  // Install CDP Fetch listener BEFORE Fetch.enable so we don't miss events.
  // byob subscribes to CDP events via Chrome's global chrome.debugger.onEvent
  // (see network-events.ts:324 for the same pattern). The handler filters by
  // tabId and method.
  const debuggerHandler = (
    source: chrome.debugger.Debuggee,
    method: string,
    params?: object,
  ): void => {
    if (source.tabId !== tab.tabId) return;
    if (method !== 'Fetch.requestPaused') return;
    // applyRules awaits CDP responses; fire-and-forget is fine because
    // chrome.debugger event delivery has no back-pressure expectation.
    void applyRules(session, entry, params as FetchRequestPausedEvent);
  };
  chrome.debugger.onEvent.addListener(debuggerHandler);
  const listenerCleanup = (): void => {
    chrome.debugger.onEvent.removeListener(debuggerHandler);
  };
  entry.listenerCleanups.push(listenerCleanup);

  // Tab-close hook: mark entry ended + release keepalive ref.
  const onRemoved = (removedTabId: number): void => {
    if (removedTabId === tab.tabId) {
      // KEEPALIVE: release on tab close before markEnded clears the listeners.
      if (entry.keepaliveHeld) {
        keepAwakeEnd();
        entry.keepaliveHeld = false;
      }
      markEnded(interceptId, 'tab_closed');
    }
  };
  chrome.tabs.onRemoved.addListener(onRemoved);
  entry.tabRemovedListener = onRemoved;

  // Enable Fetch
  try {
    await session.send('Fetch.enable', { patterns }, signal);
  } catch (e) {
    listenerCleanup();
    chrome.tabs.onRemoved.removeListener(onRemoved);
    // KEEPALIVE: release on Fetch.enable failure since we never registered.
    if (entry.keepaliveHeld) {
      keepAwakeEnd();
      entry.keepaliveHeld = false;
    }
    if (!tab.reused) await tab.cleanup();
    return {
      error: 'unknown',
      message: `Fetch.enable failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  addIntercept(entry);

  return {
    interceptId,
    tabId: tab.tabId,
    url: tabInfo?.url ?? params.url ?? '',
  };
}

interface FetchRequestPausedEvent {
  requestId: string;
  request: { url: string; method: string; headers: Record<string, string>; postData?: string };
  responseStatusCode?: number;
  responseHeaders?: Array<{ name: string; value: string }>;
}

async function applyRules(
  session: import('../cdp.js').CdpSession,
  entry: InterceptEntry,
  event: FetchRequestPausedEvent,
): Promise<void> {
  if (entry.state !== 'intercepting') {
    // Belt-and-suspenders: continue any straggler that arrives after we marked ended.
    // Branch on stage — Response-stage events need continueResponse, not continueRequest.
    const isResponseStage = event.responseStatusCode !== undefined;
    try {
      if (isResponseStage) {
        await session.send('Fetch.continueResponse', { requestId: event.requestId });
      } else {
        await session.send('Fetch.continueRequest', { requestId: event.requestId });
      }
    } catch {
      // session may already be detached
    }
    return;
  }

  entry.totalRequests++;

  const isResponseStage = event.responseStatusCode !== undefined;

  for (let i = 0; i < entry.rules.length; i++) {
    const rule = entry.rules[i];
    if (!rule) continue;
    if (!rule.regex.test(event.request.url)) continue;
    if (rule.methodSet && !rule.methodSet.has(event.request.method.toUpperCase())) continue;
    const ruleNeedsResponseStage = rule.action === 'modifyResponse';
    if (isResponseStage !== ruleNeedsResponseStage) continue;

    // hits and sampleUrls are always parallel with rules; i is in-bounds here.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    entry.hits[i] = entry.hits[i]! + 1;
    const samples = entry.sampleUrls[i];
    if (samples !== undefined && samples.length < 3) samples.push(event.request.url);

    try {
      await applyAction(session, event, rule);
    } catch (e) {
      // CDP refused; best-effort continue so the page doesn't hang.
      console.error('[byob intercept] applyAction error:', e);
      try {
        if (isResponseStage) {
          await session.send('Fetch.continueResponse', { requestId: event.requestId });
        } else {
          await session.send('Fetch.continueRequest', { requestId: event.requestId });
        }
      } catch {
        // session detached
      }
    }
    return;
  }

  // No rule matched: passthrough.
  try {
    if (isResponseStage) {
      await session.send('Fetch.continueResponse', { requestId: event.requestId });
    } else {
      await session.send('Fetch.continueRequest', { requestId: event.requestId });
    }
  } catch {
    // session detached
  }
}

async function applyAction(
  session: import('../cdp.js').CdpSession,
  event: FetchRequestPausedEvent,
  rule: CompiledRule,
): Promise<void> {
  switch (rule.action) {
    case 'block': {
      await session.send('Fetch.failRequest', {
        requestId: event.requestId,
        errorReason: rule.block?.errorReason ?? 'BlockedByClient',
      });
      return;
    }
    case 'fulfill': {
      const f = rule.fulfill ?? {};
      const responseHeaders = headersRecordToArray(f.headers ?? {});
      const body = encodeFulfillBody(f.body, f.bodyBase64);
      await session.send('Fetch.fulfillRequest', {
        requestId: event.requestId,
        responseCode: f.status ?? 200,
        responseHeaders,
        ...(body !== undefined ? { body } : {}),
      });
      return;
    }
    case 'modify': {
      const m = rule.modify ?? {};
      // Merge requestHeaders onto event.request.headers (override on key collision).
      const merged = m.requestHeaders
        ? mergeHeaders(event.request.headers, m.requestHeaders)
        : undefined;
      const params: Record<string, unknown> = { requestId: event.requestId };
      if (m.url !== undefined) params.url = m.url;
      if (m.method !== undefined) params.method = m.method;
      if (merged !== undefined) params.headers = headersRecordToArray(merged);
      await session.send('Fetch.continueRequest', params);
      return;
    }
    case 'modifyResponse': {
      const r = rule.modifyResponse ?? {};
      // 1. Get current response body (base64)
      let bodyData: string | undefined;
      let isText = true;
      const ct = headersArrayGet(event.responseHeaders ?? [], 'content-type');
      if (ct && !TEXT_LIKE_MIME.test(ct)) {
        isText = false;
      }
      if (isText && (r.bodyReplace !== undefined || r.bodyRegex !== undefined)) {
        const got = (await session.send('Fetch.getResponseBody', {
          requestId: event.requestId,
        })) as { body: string; base64Encoded: boolean };
        const original = got.base64Encoded ? base64ToUtf8(got.body) : got.body;
        let modified = original;
        if (r.bodyReplace !== undefined) {
          modified = r.bodyReplace;
        } else if (r.bodyRegex) {
          const re = new RegExp(r.bodyRegex.pattern, r.bodyRegex.flags ?? 'g');
          modified = original.replace(re, r.bodyRegex.replacement);
        }
        bodyData = utf8ToBase64(modified);
      }
      const continueParams: Record<string, unknown> = { requestId: event.requestId };
      if (r.responseStatus !== undefined) continueParams.responseCode = r.responseStatus;
      if (r.responseHeaders !== undefined) {
        const merged = mergeResponseHeaders(event.responseHeaders ?? [], r.responseHeaders);
        continueParams.responseHeaders = merged;
      }
      if (bodyData !== undefined) continueParams.body = bodyData;
      await session.send('Fetch.continueResponse', continueParams);
      return;
    }
    case 'passthrough': {
      const isResponseStage = event.responseStatusCode !== undefined;
      if (isResponseStage) {
        await session.send('Fetch.continueResponse', { requestId: event.requestId });
      } else {
        await session.send('Fetch.continueRequest', { requestId: event.requestId });
      }
      return;
    }
  }
}

// ---------- helpers ----------

/**
 * Convert a glob pattern (e.g. "https://api.github.com/*") to RegExp.
 * `**` collapses to `.*.*` (functionally equivalent to `*` here — no
 * gitignore-style "zero or more path segments" semantics).
 */
function globToRegex(glob: string): RegExp {
  // Escape regex special chars except '*' and '?', then map them to .* and . .
  let re = '';
  for (const ch of glob) {
    if (ch === '*') re += '.*';
    else if (ch === '?') re += '.';
    else if ('\\.^$+()[]{}|'.includes(ch)) re += '\\' + ch;
    else re += ch;
  }
  return new RegExp('^' + re + '$');
}

function headersRecordToArray(rec: Record<string, string>): Array<{ name: string; value: string }> {
  return Object.entries(rec).map(([name, value]) => ({ name, value }));
}

function mergeHeaders(
  base: Record<string, string>,
  overrides: Record<string, string>,
): Record<string, string> {
  // Header names are case-insensitive — index by lowercased name to dedupe.
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) out[k.toLowerCase()] = v;
  for (const [k, v] of Object.entries(overrides)) out[k.toLowerCase()] = v;
  return out;
}

function mergeResponseHeaders(
  base: Array<{ name: string; value: string }>,
  overrides: Record<string, string>,
): Array<{ name: string; value: string }> {
  const map: Record<string, string> = {};
  for (const h of base) map[h.name.toLowerCase()] = h.value;
  for (const [k, v] of Object.entries(overrides)) map[k.toLowerCase()] = v;
  return Object.entries(map).map(([name, value]) => ({ name, value }));
}

function headersArrayGet(
  arr: Array<{ name: string; value: string }>,
  name: string,
): string | undefined {
  const target = name.toLowerCase();
  for (const h of arr) if (h.name.toLowerCase() === target) return h.value;
  return undefined;
}

function encodeFulfillBody(body: string | undefined, bodyBase64: string | undefined): string | undefined {
  if (bodyBase64 !== undefined) return bodyBase64;
  if (body !== undefined) return utf8ToBase64(body);
  return undefined;
}

function utf8ToBase64(s: string): string {
  // Browser/SW environment — use TextEncoder + btoa via binary string.
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function base64ToUtf8(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

