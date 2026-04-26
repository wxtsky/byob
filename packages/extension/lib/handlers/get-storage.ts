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
    const { session, reason } = await tryAttachToTab(tab.tabId, signal);
    if (!session) return attachErrorToEnvelope(reason);

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

    const measure = (): number =>
      new TextEncoder().encode(
        JSON.stringify({
          localStorage: local,
          sessionStorage: session_,
        }),
      ).byteLength;

    if (measure() > params.maxBytes) {
      // Drop sessionStorage first.
      if (session_) {
        session_ = null;
        truncated = true;
      }
      // If still over, trim localStorage keys lexicographically.
      while (local && measure() > params.maxBytes) {
        const keys = Object.keys(local).sort();
        if (keys.length === 0) break;
        const last = keys[keys.length - 1] as string;
        delete local[last];
        truncated = true;
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

function attachErrorToEnvelope(
  reason?: 'special_page' | 'tab_gone' | 'attach_failed',
): { error: string; message: string; hint?: string } {
  if (reason === 'special_page') {
    return {
      error: 'url_forbidden',
      message: 'Tab is on a special page (chrome://, devtools://, etc.) — CDP cannot attach.',
      hint: 'Switch to a regular http(s):// tab.',
    };
  }
  if (reason === 'tab_gone') return { error: 'tab_closed', message: 'Tab was closed.' };
  return {
    error: 'cdp_attach_failed',
    message: 'Could not attach Chrome debugger after 3 retries.',
    hint: 'Close DevTools (F12) on the target tab and retry.',
  };
}
