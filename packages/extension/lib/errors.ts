import type { ErrorCodeValue } from '@byob/shared';

/**
 * A failure the agent can act on. Thrown from deep helpers (target
 * resolution, actionability, frame walking) and turned into the wire
 * envelope once, by the dispatcher, instead of every handler re-mapping
 * errors by hand.
 */
export class ByobError extends Error {
  constructor(
    public readonly code: ErrorCodeValue,
    message: string,
    public readonly hint?: string,
    public readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ByobError';
  }

  toEnvelope(): Record<string, unknown> {
    return {
      error: this.code,
      message: this.message,
      ...(this.hint ? { hint: this.hint } : {}),
      ...this.extra,
    };
  }
}

export function isByobError(e: unknown): e is ByobError {
  return e instanceof ByobError;
}

/** CDP reports a vanished backend node / context with these messages. */
export function isStaleNodeError(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return /No node with given id|Could not find node|Node with given id does not belong|Cannot find context|No node found|Node is detached/i.test(m);
}

export function isContextGoneError(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return /Cannot find context|Execution context was destroyed|Inspected target navigated/i.test(m);
}
