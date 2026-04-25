import { isSpecialUrl } from './url-guard.js';
import { waitForLoad } from './tab.js';

const ATTACH_VERSION = '1.3';
const ATTACH_MAX_RETRIES = 3;
const ATTACH_BACKOFF_MS = 500;

/**
 * Result of an attach attempt. `null` session + reason lets handlers map to
 * the right MCP error envelope (special_page vs cdp_attach_failed).
 */
export interface AttachResult {
  session: CdpSession | null;
  reason?: 'special_page' | 'tab_gone' | 'attach_failed';
}

export class CdpSession {
  // Visible to onDetach handler so it can flip the flag when Chrome detaches
  // us out-of-band (user opens DevTools, tab closes, etc.) — without that,
  // a stale `attached:true` would let the next send() throw an opaque error.
  attached = false;

  constructor(public readonly tabId: number) {}

  get isAttached(): boolean {
    return this.attached;
  }

  async attach(): Promise<boolean> {
    if (this.attached) return true;
    let lastErr: unknown;
    for (let i = 0; i < ATTACH_MAX_RETRIES; i++) {
      try {
        await chrome.debugger.attach({ tabId: this.tabId }, ATTACH_VERSION);
        this.attached = true;
        // Useful baseline: enable Runtime, opt into focus emulation so
        // background tabs work.
        await this.send('Runtime.enable', {});
        try {
          await this.send('Emulation.setFocusEmulationEnabled', { enabled: true });
        } catch {
          // not all targets support this; non-fatal
        }
        return true;
      } catch (e) {
        lastErr = e;
        if (i < ATTACH_MAX_RETRIES - 1) {
          await new Promise((r) => setTimeout(r, ATTACH_BACKOFF_MS * (i + 1)));
        }
      }
    }
    console.warn('[byob/cdp] attach failed after retries', this.tabId, lastErr);
    this.attached = false;
    return false;
  }

  async detach(): Promise<void> {
    if (!this.attached) return;
    try {
      await chrome.debugger.detach({ tabId: this.tabId });
    } catch {
      // already detached
    }
    this.attached = false;
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return new Promise((resolve, reject) => {
      chrome.debugger.sendCommand({ tabId: this.tabId }, method, params, (res?: unknown) => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message ?? `CDP ${method} failed`));
        else resolve(res as T);
      });
    });
  }

  /**
   * Evaluate an expression in the page's main world.
   * Throws if the page throws (exceptionDetails present).
   */
  async evaluate<T = unknown>(
    expression: string,
    opts: { awaitPromise?: boolean; returnByValue?: boolean } = {},
  ): Promise<T> {
    const res = await this.send<{
      result: { value?: T; type: string };
      exceptionDetails?: unknown;
    }>('Runtime.evaluate', {
      expression,
      awaitPromise: opts.awaitPromise ?? true,
      returnByValue: opts.returnByValue ?? true,
    });
    if (res.exceptionDetails) {
      throw new Error(`CDP eval threw: ${JSON.stringify(res.exceptionDetails).slice(0, 300)}`);
    }
    return res.result?.value as T;
  }
}

const sessions = new Map<number, CdpSession>();

/**
 * Backwards-compatible thin wrapper that hides the reason. Prefer
 * `tryAttachToTab` in handlers so you can map reasons to precise errors.
 */
export async function attachToTab(tabId: number): Promise<CdpSession | null> {
  const r = await tryAttachToTab(tabId);
  return r.session;
}

/**
 * Attach to a tab with three rescue passes that the original simple `attach`
 * skipped:
 *   1. Special-URL pre-check — chrome:// / about:// / devtools:// can't be
 *      attached, so fail fast with a useful reason.
 *   2. Discarded-tab revival — Chrome may GC background tabs under memory
 *      pressure. Reload + wait for load before attempting attach.
 *   3. Retry on attach error — covers transient races (e.g. user just opened
 *      then closed DevTools).
 */
export async function tryAttachToTab(tabId: number): Promise<AttachResult> {
  const existing = sessions.get(tabId);
  if (existing?.isAttached) return { session: existing };

  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return { session: null, reason: 'tab_gone' };
  }
  if (tab.url && isSpecialUrl(tab.url)) {
    console.warn('[byob/cdp] cannot attach to special page:', tab.url);
    return { session: null, reason: 'special_page' };
  }
  if (tab.discarded) {
    try {
      await chrome.tabs.reload(tabId);
      await waitForLoad(tabId, 10_000);
    } catch (e) {
      console.warn('[byob/cdp] reviving discarded tab failed:', e);
      return { session: null, reason: 'tab_gone' };
    }
  }

  const s = new CdpSession(tabId);
  if (!(await s.attach())) return { session: null, reason: 'attach_failed' };
  sessions.set(tabId, s);
  return { session: s };
}

export function getSession(tabId: number): CdpSession | null {
  const s = sessions.get(tabId);
  return s?.isAttached ? s : null;
}

export async function detachAll(): Promise<void> {
  await Promise.all([...sessions.values()].map((s) => s.detach()));
  sessions.clear();
}

// Auto-cleanup on tab close
chrome.tabs.onRemoved.addListener((tabId) => {
  const s = sessions.get(tabId);
  if (s) {
    void s.detach();
    sessions.delete(tabId);
  }
});

// Auto-cleanup on debugger detach (user opened DevTools, target crashed, etc.)
chrome.debugger.onDetach.addListener((src) => {
  if (src.tabId !== undefined) {
    const s = sessions.get(src.tabId);
    if (s) s.attached = false; // ★ also flip the flag so future send() doesn't pretend we're connected
    sessions.delete(src.tabId);
  }
});
