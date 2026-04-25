const ATTACH_VERSION = '1.3';

export class CdpSession {
  private attached = false;

  constructor(public readonly tabId: number) {}

  get isAttached(): boolean {
    return this.attached;
  }

  async attach(): Promise<boolean> {
    if (this.attached) return true;
    try {
      await chrome.debugger.attach({ tabId: this.tabId }, ATTACH_VERSION);
      this.attached = true;
      // Useful baseline: enable Runtime, opt into focus emulation so background tabs work.
      await this.send('Runtime.enable', {});
      try {
        await this.send('Emulation.setFocusEmulationEnabled', { enabled: true });
      } catch {
        // not all targets support this; non-fatal
      }
      return true;
    } catch (e) {
      console.warn('[byob/cdp] attach failed', this.tabId, e);
      this.attached = false;
      return false;
    }
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

export async function attachToTab(tabId: number): Promise<CdpSession | null> {
  const existing = sessions.get(tabId);
  if (existing?.isAttached) return existing;
  const s = new CdpSession(tabId);
  if (!(await s.attach())) return null;
  sessions.set(tabId, s);
  return s;
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

// Auto-cleanup on debugger detach (user opened DevTools, etc.)
chrome.debugger.onDetach.addListener((src) => {
  if (src.tabId !== undefined) {
    sessions.delete(src.tabId);
  }
});
