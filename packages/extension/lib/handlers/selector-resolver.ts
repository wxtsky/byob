/**
 * Translate the `byob:idx=N` selector shorthand used by browser_click /
 * browser_type into a real CSS selector that targets the
 * `data-byob-idx="N"` attribute set by the in-page interactive-element
 * collector (see ../clickable-detector.ts, run during browser_read).
 *
 * If the input doesn't match the prefix, it's returned unchanged so plain
 * CSS selectors keep working.
 *
 * IMPORTANT for callers (and for the agent reading this through tool docs):
 * indices are tied to the page-load they were collected in. SPA route
 * changes, full navigations, or major re-renders blow them away — the
 * agent must re-run browser_read to refresh the index before targeting
 * elements again.
 */
const BYOB_IDX_RE = /^byob:idx=(\d+)$/;

/** Translate the `byob:idx=N` shorthand into a real CSS selector.
 *  Optional input (for XOR schemas like browser_scroll where `selector`
 *  may be undefined) — undefined passes through. */
export function resolveByobIdxSelector(raw: string): string;
export function resolveByobIdxSelector(raw: string | undefined): string | undefined;
export function resolveByobIdxSelector(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const m = BYOB_IDX_RE.exec(raw.trim());
  if (m) return `[data-byob-idx="${m[1]}"]`;
  return raw;
}
