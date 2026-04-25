import { ErrorCode, type ErrorEnvelope } from '@byob/shared';

const HINTS: Partial<Record<string, string>> = {
  [ErrorCode.BRIDGE_NOT_RUNNING]:      'Run: byob doctor',
  [ErrorCode.EXTENSION_NOT_CONNECTED]: 'Open Chrome with the byob extension enabled.',
  [ErrorCode.CDP_ATTACH_FAILED]:       'Close DevTools (F12) on the target tab and retry.',
  [ErrorCode.URL_FORBIDDEN]:           'URL is on the byob blacklist. Set BYOB_ALLOW_FILE=1 / BYOB_ALLOW_AUTH_DOMAINS=1 to bypass.',
  [ErrorCode.EVAL_DISABLED]:           'Set BYOB_ALLOW_EVAL=1 in your MCP client config to enable browser_eval.',
};

export function asErrorEnvelope(body: unknown, fallbackMessage: string): ErrorEnvelope {
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    if (typeof b.error === 'string') {
      return {
        error: b.error as ErrorEnvelope['error'],
        message: typeof b.message === 'string' ? b.message : fallbackMessage,
        hint: typeof b.hint === 'string' ? b.hint : HINTS[b.error as string],
        aborted: b.aborted === true ? true : undefined,
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
