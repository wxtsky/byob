/**
 * Tiny helpers shared by every handler when they need to race long-running
 * work against an AbortSignal coming from the SW dispatcher.
 *
 * Signal semantics: we throw a `DOMException` with name 'AbortError' on abort,
 * matching the standard fetch/AbortController contract. The dispatcher in
 * background.ts catches this and replaces the result envelope with the
 * `aborted` (or `aborted_due_to_wake`) error envelope.
 */

export function abortError(reason: string = 'aborted'): Error {
  // Use a DOMException-compatible shape; MV3 SW has DOMException available.
  const err: Error & { name?: string; aborted?: true; reason?: string } =
    typeof DOMException !== 'undefined'
      ? (new DOMException(reason, 'AbortError') as unknown as Error)
      : Object.assign(new Error(reason), { name: 'AbortError' });
  (err as { aborted?: true }).aborted = true;
  (err as { reason?: string }).reason = reason;
  return err;
}

export function isAbortError(e: unknown): boolean {
  return !!(e && typeof e === 'object' && (e as { name?: string }).name === 'AbortError');
}

/** Promise that rejects with abortError when the signal fires (or rejects immediately if already aborted). */
export function abortPromise(signal: AbortSignal): Promise<never> {
  if (signal.aborted) {
    return Promise.reject(abortError(typeof signal.reason === 'string' ? signal.reason : 'aborted'));
  }
  return new Promise((_, reject) => {
    signal.addEventListener(
      'abort',
      () => reject(abortError(typeof signal.reason === 'string' ? signal.reason : 'aborted')),
      { once: true },
    );
  });
}

/** Race an async op against the signal; abort wins if the signal fires first. */
export function raceWithSignal<T>(op: Promise<T>, signal: AbortSignal): Promise<T> {
  return Promise.race([op, abortPromise(signal)]);
}

/** Like `await new Promise(r => setTimeout(r, ms))` but cancellable. */
export function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError('aborted'));
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(abortError(typeof signal.reason === 'string' ? signal.reason : 'aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Throws abortError if the signal already fired. Cheap inline check. */
export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(typeof signal.reason === 'string' ? signal.reason : 'aborted');
}
