export const ErrorCode = {
  BRIDGE_NOT_RUNNING:      'bridge_not_running',
  EXTENSION_NOT_CONNECTED: 'extension_not_connected',
  CHROME_NOT_RUNNING:      'chrome_not_running',
  CDP_ATTACH_FAILED:       'cdp_attach_failed',
  CDP_DETACHED_UNEXPECTED: 'cdp_detached',
  TAB_CLOSED:              'tab_closed',
  TAB_NAVIGATED:           'tab_navigated',
  TIMEOUT:                 'timeout',
  SELECTOR_NOT_FOUND:      'selector_not_found',
  ELEMENT_NOT_VISIBLE:     'element_not_visible',
  // EVAL_DISABLED: reserved. Currently never emitted — mcp-server gates
  // the browser_eval tool at registration time (BYOB_ALLOW_EVAL=1), so
  // a disabled eval never reaches a handler. Kept for future runtime
  // gating where the tool would still register but refuse at call time.
  EVAL_DISABLED:           'eval_disabled',
  EVAL_EXCEPTION:          'eval_exception',
  URL_FORBIDDEN:           'url_forbidden',
  RATE_LIMITED:            'rate_limited',
  RECORDING_NOT_FOUND:      'recording_not_found',
  RECORDING_FAILED_TO_ATTACH: 'recording_failed_to_attach',
  FRAME_NOT_FOUND:               'frame_not_found',
  FRAME_NAVIGATION_DURING_OP:    'frame_navigation_during_op',
  FRAME_ATTACH_FAILED:           'frame_attach_failed',
  FRAME_EVAL_BLOCKED:            'frame_eval_blocked',
  // NEW in v0.2: cancel propagation
  ABORTED:                 'aborted',
  ABORTED_DUE_TO_WAKE:     'aborted_due_to_wake',
  // NEW in v0.2: read_markdown — Readability extraction failures
  READABILITY_NO_ARTICLE:  'readability_no_article',
  HTML_PARSE_FAILED:       'html_parse_failed',
  // NEW in v0.3 Batch 1
  OPTION_NOT_FOUND:        'option_not_found',
  NO_HISTORY:              'no_history',
  // NEW in v0.3 Batch 2
  NOT_A_FILE_INPUT:        'not_a_file_input',
  FILE_NOT_FOUND:          'file_not_found',
  // NEW in v0.3 Batch 3
  INTERCEPT_NOT_FOUND:     'intercept_not_found',
  // Browser session parity
  DIALOG_NOT_FOUND:        'dialog_not_found',
  INVALID_DIALOG_ACTION:   'invalid_dialog_action',
  ELEMENT_NOT_FOCUSED:     'element_not_focused',
  CLIPBOARD_FAILED:        'clipboard_failed',
  // Sentinel — keep UNKNOWN last.
  UNKNOWN:                 'unknown',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface ErrorEnvelope {
  error: ErrorCodeValue;
  message: string;
  hint?: string;
  aborted?: boolean;
  /** When error === 'frame_not_found', the failing index in framePath (0-based). */
  framePathIndex?: number;
  /** Free-form sub-reason for frame_* errors: 'not_an_iframe' | 'frame_blank' | 'flatten_unsupported' | etc. */
  reason?: string;
  /** When error === 'eval_exception', the raw CDP Runtime.exceptionDetails — includes
   *  `text`, `exception.description`, `lineNumber`, `columnNumber`, `stackTrace`, etc.
   *  Pass-through from extension so callers can debug the actual JS error rather than
   *  guess at a generic "Page threw during eval". */
  exceptionDetails?: unknown;
}
