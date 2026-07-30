import { GetStorageInput } from '@byob/shared';
import { tryAttachToTab } from '../cdp.js';
import {
  resolveFrame,
  evaluateInResolvedFrame,
  frameErrorToEnvelope,
} from '../frame-resolver.js';
import { openOrReuse } from '../tab.js';
import { checkUrlAllowed, urlForbiddenError } from '../url-guard.js';
import { throwIfAborted } from '../signal-utils.js';
import { attachErrorEnvelope } from '../attach-error.js';

interface StorageDump {
  origin: string;
  local: Record<string, string> | null;
  session: Record<string, string> | null;
}

export async function handleGetStorage(
  rawParams: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const params = GetStorageInput.parse(rawParams);
  if (params.url) {
    const guard = checkUrlAllowed(params.url);
    if (!guard.ok) return urlForbiddenError(guard.reason);
  }
  throwIfAborted(signal);

  const tab = await openOrReuse({ url: params.url, tabId: params.tabId, signal });

  try {
    const attachResult = await tryAttachToTab(tab.tabId, signal);
  const { session } = attachResult;
    if (!session) return attachErrorEnvelope(attachResult);

    let frame;
    try {
      frame = await resolveFrame(session, params.framePath, signal);
    } catch (e) {
      const env = frameErrorToEnvelope(e);
      if (env) return env;
      throw e;
    }

    const wantLocal = params.kind === 'local' || params.kind === 'both';
    const wantSession = params.kind === 'session' || params.kind === 'both';
    const expr = `(() => {
      const dump = (s) => {
        const out = {};
        for (let i = 0; i < s.length; i++) {
          const k = s.key(i);
          if (k !== null) out[k] = s.getItem(k) ?? '';
        }
        return out;
      };
      return {
        origin: location.origin,
        local: ${wantLocal ? 'dump(localStorage)' : 'null'},
        session: ${wantSession ? 'dump(sessionStorage)' : 'null'},
      };
    })()`;

    const dump = await evaluateInResolvedFrame<StorageDump>(
      session,
      frame,
      expr,
      { awaitPromise: false, returnByValue: true, signal },
    );

    const tabInfo = await chrome.tabs.get(tab.tabId).catch(() => null);
    let local = dump.local;
    let session_ = dump.session;
    let truncated = false;

    // Precompute per-entry byte costs (key + value + JSON overhead). We then
    // pop keys lexicographically until under maxBytes, decrementing the
    // running total instead of re-stringifying the whole dump each loop.
    const enc = new TextEncoder();
    const stringifiedBytes = (s: string): number => enc.encode(JSON.stringify(s)).byteLength;
    const entryBytes = (k: string, v: string): number =>
      // {"key":"value"} has 5 chars of structure: 2 quotes + colon + 2 quotes
      // around value (already counted by stringifiedBytes), then a trailing
      // comma between entries. Slight overestimate is fine.
      stringifiedBytes(k) + 1 + stringifiedBytes(v) + 1;
    const containerBytes = (label: string): number =>
      // `,"localStorage":{}` etc.
      stringifiedBytes(label) + 3;

    const baseBytes = enc.encode('{"localStorage":null,"sessionStorage":null}').byteLength;
    let currentBytes = baseBytes;
    if (local) {
      currentBytes += containerBytes('localStorage') - 4 /* the literal "null" */;
      for (const [k, v] of Object.entries(local)) currentBytes += entryBytes(k, v);
    }
    if (session_) {
      currentBytes += containerBytes('sessionStorage') - 4;
      for (const [k, v] of Object.entries(session_)) currentBytes += entryBytes(k, v);
    }

    if (currentBytes > params.maxBytes) {
      // Drop sessionStorage first (cheaper to discard than to fight over).
      if (session_) {
        for (const [k, v] of Object.entries(session_)) currentBytes -= entryBytes(k, v);
        currentBytes -= containerBytes('sessionStorage') - 4;
        session_ = null;
        truncated = true;
      }
      if (local && currentBytes > params.maxBytes) {
        // Pop largest keys lexicographically until under budget. Sort once.
        const keys = Object.keys(local).sort();
        while (keys.length > 0 && currentBytes > params.maxBytes) {
          const last = keys.pop()!;
          const v = local[last];
          if (v !== undefined) currentBytes -= entryBytes(last, v);
          delete local[last];
          truncated = true;
        }
      }
    }

    const out: {
      tabId: number;
      url: string;
      origin: string;
      localStorage?: Record<string, string>;
      sessionStorage?: Record<string, string>;
      byteLength: number;
      truncated: boolean;
    } = {
      tabId: tab.tabId,
      url: tabInfo?.url ?? params.url ?? '',
      origin: dump.origin,
      byteLength: 0,
      truncated,
    };
    if (local !== null) out.localStorage = local;
    if (session_ !== null) out.sessionStorage = session_;
    out.byteLength = new TextEncoder().encode(
      JSON.stringify({
        localStorage: out.localStorage ?? null,
        sessionStorage: out.sessionStorage ?? null,
      }),
    ).byteLength;
    return out;
  } finally {
    if (!tab.reused) await tab.cleanup();
  }
}

