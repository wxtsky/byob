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
  EVAL_DISABLED:           'eval_disabled',
  EVAL_EXCEPTION:          'eval_exception',
  URL_FORBIDDEN:           'url_forbidden',
  RATE_LIMITED:            'rate_limited',
  RECORDING_NOT_FOUND:      'recording_not_found',
  RECORDING_FAILED_TO_ATTACH: 'recording_failed_to_attach',
  UNKNOWN:                 'unknown',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface ErrorEnvelope {
  error: ErrorCodeValue;
  message: string;
  hint?: string;
  aborted?: boolean;
}
