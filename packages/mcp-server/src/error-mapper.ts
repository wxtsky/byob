import { ErrorCode, type ErrorCodeValue, type ErrorEnvelope } from '@byob/shared';

const HINTS: Partial<Record<string, string>> = {
  [ErrorCode.BRIDGE_NOT_RUNNING]:      'Run: byob doctor',
  [ErrorCode.EXTENSION_NOT_CONNECTED]: 'Open Chrome with the byob extension enabled.',
  [ErrorCode.CDP_ATTACH_FAILED]:       'Close DevTools (F12) on the target tab and retry.',
  [ErrorCode.URL_FORBIDDEN]:           'URL is on the byob blacklist. Set BYOB_ALLOW_FILE=1 / BYOB_ALLOW_AUTH_DOMAINS=1 to bypass.',
  [ErrorCode.EVAL_DISABLED]:           'Set BYOB_ALLOW_EVAL=1 in your MCP client config to enable browser_eval.',
  [ErrorCode.ABORTED]:                 'The request was cancelled by the client. Re-run if you still need the result.',
  [ErrorCode.ABORTED_DUE_TO_WAKE]:     'The request was cancelled because the system woke from sleep. Re-run; CDP state has been reset.',
  [ErrorCode.READABILITY_NO_ARTICLE]:  'Readability could not identify a main article on this page. Fall back to browser_read for noisy / SPA pages.',
  [ErrorCode.HTML_PARSE_FAILED]:       'The page HTML could not be parsed. Try reloading the tab or use browser_read for the raw DOM.',
  [ErrorCode.DIALOG_NOT_FOUND]:        'Call browser_get_js_dialog immediately before handling a dialog.',
  [ErrorCode.ELEMENT_NOT_FOCUSED]:     'Click or focus an editable field, then retry browser_type without a selector.',
  [ErrorCode.CLIPBOARD_FAILED]:        'Allow clipboard access for the byob extension, then retry the explicit clipboard operation.',
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
      return {
        error: code,
        message: typeof b.message === 'string' ? b.message : fallbackMessage,
        hint: typeof b.hint === 'string' ? b.hint : HINTS[b.error],
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

export function toMcpError(env: ErrorEnvelope): {
  isError: true;
  content: Array<{ type: 'text'; text: string }>;
} {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(env) }] };
}
