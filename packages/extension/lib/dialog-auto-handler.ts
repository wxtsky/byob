/**
 * Auto-dismiss JS dialogs (alert / confirm / prompt / beforeunload) on any
 * tab that byob has attached CDP to. Without this, a click that triggers
 * `confirm("Are you sure?")` blocks the entire CDP session — handler awaits
 * never resolve until a human walks over and clicks the button.
 *
 * Strategy (mirrors browser-use's `popups_watchdog` policy table):
 *   • alert         → accept (just dismisses it)
 *   • confirm       → accept (safer for automation; LLM-driven flows assume
 *                              they meant the affirmative)
 *   • prompt        → dismiss (we have no idea what to type)
 *   • beforeunload  → accept (let navigation proceed)
 *
 * Each handled dialog is also surfaced via `console.warn('[byob/dialog] ...')`
 * in the page so `browser_get_console_logs` callers can see what was
 * auto-clicked. We avoid adding a new MCP tool just for this.
 *
 * Listener uses `hasListener?.()` so dev hot-reload doesn't stack copies,
 * matching the pattern in cdp.ts / wake-watch.ts.
 */

const HANDLER_DISABLED_FLAG = 'BYOB_DISABLE_AUTO_DIALOG_HANDLER';
let disabled = false;

interface DialogParams {
  type?: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
  message?: string;
  url?: string;
  defaultPrompt?: string;
}

function decisionFor(type: DialogParams['type']): 'accept' | 'dismiss' {
  // prompt is the only one we explicitly dismiss — accepting it would send
  // an empty string to the page, which is rarely what the LLM wanted.
  return type === 'prompt' ? 'dismiss' : 'accept';
}

function onDebuggerDialogEvent(
  source: chrome.debugger.Debuggee,
  method: string,
  params?: object,
): void {
  if (disabled) return;
  if (method !== 'Page.javascriptDialogOpening') return;
  if (source.tabId === undefined) return;

  const p = (params ?? {}) as DialogParams;
  const type = p.type ?? 'alert';
  const accept = decisionFor(type) === 'accept';

  // Dismiss/accept first — the page is blocked on this dialog and any other
  // CDP / scripting work targeting this tab would queue (or worse, fail
  // silently) until the dialog is closed.
  const tabId = source.tabId;
  const note = `[byob/dialog] ${type}: ${(p.message ?? '').slice(0, 200)} → auto-${accept ? 'accepted' : 'dismissed'}`;

  void chrome.debugger
    .sendCommand({ tabId }, 'Page.handleJavaScriptDialog', { accept })
    .then(
      () =>
        // Surface to the page console so get-console-logs picks it up. Errors
        // (page navigated away, special URL) are non-fatal.
        chrome.scripting
          .executeScript({
            target: { tabId },
            func: (msg: string) => console.warn(msg),
            args: [note],
          })
          .catch(() => {}),
      () => {
        // sendCommand failed (tab closed); skip the surfacing too.
      },
    );
}

export function startDialogAutoHandler(): void {
  // Hydrate the disabled flag from chrome.storage.local once at boot. Users
  // opt out via the SW console: chrome.storage.local.set({ [FLAG]: true }).
  void chrome.storage.local.get(HANDLER_DISABLED_FLAG).then((stored) => {
    disabled = stored[HANDLER_DISABLED_FLAG] === true;
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const change = changes[HANDLER_DISABLED_FLAG];
    if (change) disabled = change.newValue === true;
  });

  if (!chrome.debugger.onEvent.hasListener?.(onDebuggerDialogEvent)) {
    chrome.debugger.onEvent.addListener(onDebuggerDialogEvent);
  }
}
