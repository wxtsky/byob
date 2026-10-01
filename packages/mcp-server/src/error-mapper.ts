import { ErrorCode, type ErrorCodeValue, type ErrorEnvelope } from '@byob/shared';
import { RELOAD_HINT } from './bridge-client.js';

// Hints are read by the agent, which can't run byob's CLI: say what to tell
// the user, not which command to run.
const HINTS: Partial<Record<string, string>> = {
  [ErrorCode.BRIDGE_NOT_RUNNING]:      'Ask the user to open Chrome and check that byob is enabled in chrome://extensions.',
  [ErrorCode.EXTENSION_NOT_CONNECTED]: 'Ask the user to check that byob is enabled in chrome://extensions (reload it if it is).',
  [ErrorCode.CDP_ATTACH_FAILED]:       'Close DevTools (F12) on that tab, or another extension using the debugger, and retry.',
  [ErrorCode.URL_FORBIDDEN]:           "Blocked by the user's byob site policy. Tell the user; only they can change it.",
  [ErrorCode.EVAL_DISABLED]:           'Set BYOB_ALLOW_EVAL=1 in the MCP server environment to enable page JavaScript.',
  [ErrorCode.ABORTED]:                 'The request was cancelled. Re-run it if you still need the result.',
  [ErrorCode.ABORTED_DUE_TO_WAKE]:     'The computer woke from sleep and byob reset its browser sessions. Re-run.',
  [ErrorCode.DIALOG_NOT_FOUND]:        'No dialog is open — browser_dialog with action "get" shows the current one.',
  [ErrorCode.ELEMENT_NOT_FOCUSED]:     'Pass ref/selector of the field to browser_type, or click it first.',
  [ErrorCode.CLIPBOARD_FAILED]:        'Chrome refused clipboard access for the byob extension.',
  [ErrorCode.TAB_CLOSED]:              'The tab is gone. browser_tabs lists open tabs.',
  [ErrorCode.TIMEOUT]:                 'Raise timeoutSec, or wait for something more specific with browser_wait.',
};

const KNOWN_ERROR_CODES: Set<string> = new Set(Object.values(ErrorCode));

/** Coerce a server-side `error` string to a known ErrorCodeValue, or
 *  fall back to UNKNOWN. The original value is returned alongside so
 *  callers can surface it without losing information. */
function coerceErrorCode(raw: string): { code: ErrorCodeValue; original: string | null } {
  if (KNOWN_ERROR_CODES.has(raw)) {
    return { code: raw as ErrorCodeValue, original: null };
  }
  return { code: ErrorCode.UNKNOWN, original: raw };
}

export function asErrorEnvelope(
  body: unknown,
  fallbackMessage: string,
): ErrorEnvelope & { _originalError?: string } {
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    if (typeof b.error === 'string') {
      const { code, original } = coerceErrorCode(b.error);
      const message = typeof b.message === 'string' ? b.message : fallbackMessage;
      // The extension predates this MCP server's tool (plugin upgraded,
      // extension not reloaded yet).
      const stale = /^No handler for /.test(message)
        ? `The byob extension is older than this MCP server — ask the user to ${RELOAD_HINT}.`
        : undefined;
      return {
        error: code,
        message,
        hint: typeof b.hint === 'string' ? b.hint : stale ?? HINTS[b.error],
        aborted: b.aborted === true ? true : undefined,
        framePathIndex: typeof b.framePathIndex === 'number' ? b.framePathIndex : undefined,
        reason: typeof b.reason === 'string' ? b.reason : undefined,
        // exceptionDetails is opaque (CDP Runtime.exceptionDetails); pass through unchanged
        // so eval_exception callers can see the real JS error instead of "Page threw".
        exceptionDetails: b.exceptionDetails,
        // When the bridge sent an error code we don't recognize (typo,
        // newer bridge talking to older mcp-server), preserve the original
        // string so debugging doesn't dead-end at "unknown".
        ...(original ? { _originalError: original } : {}),
      };
    }
  }
  return { error: ErrorCode.UNKNOWN, message: fallbackMessage };
}
