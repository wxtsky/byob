import { waitForLoad } from './tab.js';
import { classifyAttachUrl } from './tab-access.js';
import { noteAttached } from './console-buffer.js';

const ATTACH_VERSION = '1.3';
const ATTACH_MAX_RETRIES = 3;
const ATTACH_BACKOFF_MS = 500;

/**
 * Result of an attach attempt. `null` session + reason lets handlers map to
 * the right MCP error envelope (special_page vs cdp_attach_failed vs
 * flatten_unsupported).
 */
export interface AttachResult {
  session: CdpSession | null;
  reason?:
    | 'special_page'
    | 'tab_gone'
    | 'attach_failed'
    | 'flatten_unsupported'
    | 'host_forbidden';
  /** Populated for reason==='host_forbidden' — which policy rule refused. */
  reasonDetail?: string;
}

/**
 * Sentinel thrown from CdpSession.attach when Target.setAutoAttach with
 * `flatten:true` is rejected. Older Chromes (< 78) and a handful of
 * embedded forks lack flatten — that's a permanent condition for the
 * current process, so callers shouldn't retry the attach loop on it.
 *
 * Caught + converted to AttachResult.reason='flatten_unsupported' in
 * tryAttachToTab below; callers outside that path should handle it
 * the same way.
 */
export class FlattenUnsupportedError extends Error {
  constructor() {
    super('flatten_unsupported');
    this.name = 'FlattenUnsupportedError';
  }
}

/** Linear backoff between attach attempts; rejects early on abort. */
function backoff(attempt: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ATTACH_BACKOFF_MS * (attempt + 1));
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

const goneListeners = new Set<(tabId: number) => void>();

/**
 * Run `fn` whenever byob loses a tab's debugger attachment — Chrome detached
 * it (DevTools, crash, tab closed) or byob detached it itself.
 */
export function onAttachmentGone(fn: (tabId: number) => void): void {
  goneListeners.add(fn);
}

function notifyAttachmentGone(tabId: number): void {
  for (const fn of goneListeners) {
    try {
      fn(tabId);
    } catch (e) {
      console.warn('[byob/cdp] attachment-gone listener failed', e);
    }
  }
}

export class CdpSession {
  // Visible to onDetach handler so it can flip the flag when Chrome detaches
  // us out-of-band (user opens DevTools, tab closes, etc.) — without that,
  // a stale `attached:true` would let the next send() throw an opaque error.
  attached = false;
  /** Who needs the Network domain on this attachment (recordings, emulation). */
  private readonly networkUsers = new Set<string>();

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
      } catch (e) {
        lastErr = e;
        // Attaches are serialized per tab and no live session is tracked, so
        // an existing attachment of ours is an orphan (service-worker
        // restart, an older failed attach). Nothing would ever detach it and
        // the tab would stay unusable. detach() only succeeds on an
        // attachment this extension owns.
        if (/already attached/i.test(e instanceof Error ? e.message : String(e))) {
          await chrome.debugger.detach({ tabId: this.tabId }).catch(() => {});
        }
        if (i < ATTACH_MAX_RETRIES - 1) await backoff(i, signal);
        continue;
      }
      this.attached = true;
      noteAttached(this.tabId);
      try {
        await this.enableDomains(signal);
        return true;
      } catch (e) {
        // Never keep an attachment that nothing tracks: every later attach
        // to this tab would fail with "already attached".
        await this.detach();
        if (e instanceof FlattenUnsupportedError || (e as { name?: string }).name === 'AbortError') throw e;
        lastErr = e;
        if (i < ATTACH_MAX_RETRIES - 1) await backoff(i, signal);
      }
    }
    console.warn('[byob/cdp] attach failed after retries', this.tabId, lastErr);
    this.attached = false;
    return false;
  }

  /** The domains every attachment needs. Throws AbortError or FlattenUnsupportedError as is. */
  private async enableDomains(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    // Enable Page so the dialog registry receives
    // `Page.javascriptDialogOpening` / `Closed` events. Dialog choices
    // are explicit MCP calls; we never auto-accept a confirmation. Do
    // this before Runtime.enable so an already-open dialog is observable
    // even if another domain command would wait behind it.
    try {
      await this.send('Page.enable', {}, signal);
    } catch (e) {
      if ((e as { name?: string }).name === 'AbortError') throw e;
      // Page domain is universally supported on real Chrome; a failure
      // here is suspicious but non-fatal — continue without dialog visibility.
      console.warn('[byob/cdp] Page.enable failed (dialog tracking disabled for this tab):', e);
    }
    // Useful baseline: enable Runtime, opt into focus emulation so
    // background tabs work.
    await this.send('Runtime.enable', {}, signal);
    // Log replays what the browser collected before we attached (uncaught
    // errors, failed requests) into the console buffer.
    await this.send('Log.enable', {}, signal).catch(() => {});
    // Flatten auto-attach: parent session transparently receives traffic
    // for all child frames (including cross-origin OOPIFs) addressed via
    // the `sessionId` field. Required for cross-frame addressing.
    try {
      await this.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, signal);
    } catch (e) {
      if ((e as { name?: string }).name === 'AbortError') throw e;
      // Older Chrome (< 78) lacks flatten — permanent for this browser, so
      // don't retry. A named class lets callers `instanceof` it.
      console.warn('[byob/cdp] Target.setAutoAttach flatten unsupported:', e);
      throw new FlattenUnsupportedError();
    }
    try {
      await this.send('Emulation.setFocusEmulationEnabled', { enabled: true }, signal);
    } catch (e) {
      if ((e as { name?: string }).name === 'AbortError') throw e;
      // not all targets support this; non-fatal
    }
  }

  /**
   * Detach and drop the per-tab state built on this attachment (frames,
   * contexts, OOPIF sessions). chrome.debugger.onDetach does not fire when
   * the extension detaches by itself, so the cleanup can't rely on it.
   */
  async detach(): Promise<void> {
    if (!this.attached) return;
    try {
      await chrome.debugger.detach({ tabId: this.tabId });
    } catch {
      // already detached
    }
    this.attached = false;
    notifyAttachmentGone(this.tabId);
  }

  /** Enable the Network domain on behalf of `user`. */
  async useNetwork(user: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<void> {
    if (this.networkUsers.size === 0 || Object.keys(params).length > 0) {
      await this.send('Network.enable', params, signal);
    }
    this.networkUsers.add(user);
  }

  /**
   * Give up `user`'s claim on the Network domain. Network.disable also drops
   * offline/header emulation and stops every other recording on the tab, so
   * it is only sent once nobody is left.
   */
  async releaseNetwork(user: string): Promise<void> {
    if (!this.networkUsers.delete(user) || this.networkUsers.size > 0 || !this.attached) return;
    await this.send('Network.disable').catch(() => {});
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
  // One attach per tab at a time. Parallel calls (snapshot + console, …)
  // used to race two chrome.debugger.attach()es, and the loser reported
  // cdp_attach_failed. Waiters re-run the checks, which are cheap once the
  // first attach has finished and the session is cached.
  for (let pending = attaching.get(tabId); pending; pending = attaching.get(tabId)) {
    await untilSettledOrAborted(pending, signal);
  }
  const p = attachOnce(tabId, signal);
  attaching.set(tabId, p);
  try {
    return await p;
  } finally {
    if (attaching.get(tabId) === p) attaching.delete(tabId);
  }
}

const attaching = new Map<number, Promise<AttachResult>>();

function untilSettledOrAborted(p: Promise<unknown>, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'));
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => reject(new DOMException('aborted', 'AbortError'));
    signal?.addEventListener('abort', onAbort, { once: true });
    void p.then(
      () => undefined,
      () => undefined,
    ).then(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    });
  });
}

async function attachOnce(tabId: number, signal?: AbortSignal): Promise<AttachResult> {
  const existing = sessions.get(tabId);

  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    if (existing) {
      await existing.detach();
      sessions.delete(tabId);
    }
    return { session: null, reason: 'tab_gone' };
  }
  // Enforce the complete URL boundary here rather than per-handler. Two
  // thirds of byob's tools take a bare tabId, so handler-only checks would
  // let callers bypass protocol, auth-host, and user host-policy rules.
  const access = classifyAttachUrl(tab.url);
  if (!access.ok) {
    console.warn('[byob/cdp] URL policy refused attach:', access.reasonDetail);
    if (existing) {
      await existing.detach();
      sessions.delete(tabId);
    }
    return {
      session: null,
      reason: access.reason,
      reasonDetail: access.reasonDetail,
    };
  }
  // Check the live URL before reusing a session. A tab can navigate from an
  // allowed page to a denied host while its CDP attachment stays alive; an
  // early session-cache return would otherwise bypass the policy.
  if (existing?.isAttached) return { session: existing };
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
  try {
    if (!(await s.attach(signal))) return { session: null, reason: 'attach_failed' };
  } catch (e) {
    // FlattenUnsupportedError is the one expected throw out of attach()
    // (besides AbortError). Surface it as a discrete reason so handlers
    // can render a precise hint instead of treating it as a generic
    // attach failure.
    if (e instanceof FlattenUnsupportedError) {
      return { session: null, reason: 'flatten_unsupported' };
    }
    throw e;
  }
  sessions.set(tabId, s);
  return { session: s };
}

export function getSession(tabId: number): CdpSession | null {
  const s = sessions.get(tabId);
  return s?.isAttached ? s : null;
}

export async function detachAll(): Promise<void> {
  // allSettled: a failing detach must not stop sessions.clear() — if we
  // bail early, stale entries linger and the next attach short-circuits
  // on `existing?.isAttached` against a dead session.
  await Promise.allSettled([...sessions.values()].map((s) => s.detach()));
  sessions.clear();
}

// Auto-cleanup on tab close. Listener is a named function + hasListener guard
// so dev hot-reload / re-import doesn't stack duplicates.
function onTabRemovedDetach(tabId: number): void {
  const s = sessions.get(tabId);
  if (s) {
    void s.detach();
    sessions.delete(tabId);
  }
}
if (!chrome.tabs.onRemoved.hasListener?.(onTabRemovedDetach)) {
  chrome.tabs.onRemoved.addListener(onTabRemovedDetach);
}

// Auto-cleanup on debugger detach (user opened DevTools, target crashed, etc.)
function onDebuggerForceDetach(src: chrome.debugger.Debuggee): void {
  if (src.tabId !== undefined) {
    const s = sessions.get(src.tabId);
    if (s) s.attached = false; // ★ also flip the flag so future send() doesn't pretend we're connected
    sessions.delete(src.tabId);
    notifyAttachmentGone(src.tabId);
  }
}
if (!chrome.debugger.onDetach.hasListener?.(onDebuggerForceDetach)) {
  chrome.debugger.onDetach.addListener(onDebuggerForceDetach);
}
