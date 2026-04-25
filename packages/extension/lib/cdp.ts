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

  async attach(signal?: AbortSignal): Promise<boolean> {
    if (this.attached) return true;
    let lastErr: unknown;
    for (let i = 0; i < ATTACH_MAX_RETRIES; i++) {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      try {
        await chrome.debugger.attach({ tabId: this.tabId }, ATTACH_VERSION);
        this.attached = true;
        // If the caller already aborted between the attach and the next
        // step, detach and bail out — keeping CDP state consistent.
        if (signal?.aborted) {
          await this.detach();
          throw new DOMException('aborted', 'AbortError');
        }
        // Useful baseline: enable Runtime, opt into focus emulation so
        // background tabs work.
        await this.send('Runtime.enable', {}, signal);
        // Flatten auto-attach: parent session transparently receives traffic
        // for all child frames (including cross-origin OOPIFs) addressed via
        // the `sessionId` field. Required for cross-frame addressing.
        try {
          await this.send(
            'Target.setAutoAttach',
            {
              autoAttach: true,
              waitForDebuggerOnStart: false,
              flatten: true,
            },
            signal,
          );
        } catch (e) {
          // Propagate aborts cleanly — they are not a "flatten unsupported" signal.
          if ((e as { name?: string }).name === 'AbortError') {
            await this.detach();
            throw e;
          }
          // Older Chrome (< 78) lacks flatten. Detach and surface a clear
          // reason so callers can show the user a useful hint.
          console.warn('[byob/cdp] Target.setAutoAttach flatten unsupported:', e);
          await chrome.debugger.detach({ tabId: this.tabId }).catch(() => {});
          this.attached = false;
          throw new Error('flatten_unsupported');
        }
        try {
          await this.send('Emulation.setFocusEmulationEnabled', { enabled: true }, signal);
        } catch (e) {
          // Abort during focus emulation should still propagate so we don't
          // leave the caller hanging — the surrounding catch detaches us.
          if ((e as { name?: string }).name === 'AbortError') {
            await this.detach();
            throw e;
          }
          // not all targets support this; non-fatal
        }
        return true;
      } catch (e) {
        if ((e as { name?: string }).name === 'AbortError') throw e;
        lastErr = e;
        if (i < ATTACH_MAX_RETRIES - 1) {
          // Cancellable backoff so abort doesn't have to wait the full backoff.
          await new Promise<void>((resolve, reject) => {
            const t = setTimeout(resolve, ATTACH_BACKOFF_MS * (i + 1));
            signal?.addEventListener(
              'abort',
              () => {
                clearTimeout(t);
                reject(new DOMException('aborted', 'AbortError'));
              },
              { once: true },
            );
          });
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

  send<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException('aborted', 'AbortError'));
        return;
      }
      let settled = false;
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        reject(new DOMException('aborted', 'AbortError'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      chrome.debugger.sendCommand({ tabId: this.tabId }, method, params, (res?: unknown) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
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
    opts: { awaitPromise?: boolean; returnByValue?: boolean; signal?: AbortSignal } = {},
  ): Promise<T> {
    const res = await this.send<{
      result: { value?: T; type: string };
      exceptionDetails?: unknown;
    }>(
      'Runtime.evaluate',
      {
        expression,
        awaitPromise: opts.awaitPromise ?? true,
        returnByValue: opts.returnByValue ?? true,
      },
      opts.signal,
    );
    if (res.exceptionDetails) {
      throw new Error(`CDP eval threw: ${JSON.stringify(res.exceptionDetails).slice(0, 300)}`);
    }
    return res.result?.value as T;
  }

  /**
   * Send a CDP command on a flatten-attached child session (OOPIF).
   * The `sessionId` is what `Target.attachedToTarget` events delivered.
   * For same-origin frames just use `send()`.
   *
   * Mirrors `send()`'s signal handling so OOPIF operations are cancellable —
   * without this, an aborted top-level handler would still leave child-frame
   * CDP awaits hanging until Chrome's own timeout.
   */
  sendOnSession<T = unknown>(
    sessionId: string,
    method: string,
    params: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException('aborted', 'AbortError'));
        return;
      }
      let settled = false;
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        reject(new DOMException('aborted', 'AbortError'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      chrome.debugger.sendCommand(
        { tabId: this.tabId, sessionId } as chrome.debugger.Debuggee,
        method,
        params,
        (res?: unknown) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener('abort', onAbort);
          const err = chrome.runtime.lastError;
          if (err) reject(new Error(err.message ?? `CDP ${method} failed (sess ${sessionId})`));
          else resolve(res as T);
        },
      );
    });
  }
}

const sessions = new Map<number, CdpSession>();

/**
 * Backwards-compatible thin wrapper that hides the reason. Prefer
 * `tryAttachToTab` in handlers so you can map reasons to precise errors.
 */
export async function attachToTab(tabId: number, signal?: AbortSignal): Promise<CdpSession | null> {
  const r = await tryAttachToTab(tabId, signal);
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
 *
 * Note: tryAttachToTab does not race chrome.tabs.get/reload against the
 * signal because those resolve in single-digit ms; the long-pole is attach()
 * itself which is now cancellable.
 */
export async function tryAttachToTab(
  tabId: number,
  signal?: AbortSignal,
): Promise<AttachResult> {
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
  if (!(await s.attach(signal))) return { session: null, reason: 'attach_failed' };
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
