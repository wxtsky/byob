/**
 * JSON results for scripts (Code Mode, see mode.ts): the extension's own
 * result objects, minus internal fields, kept under a size budget.
 */
import { saveOutput } from './files.js';

type R = Record<string, any>;

/**
 * Claude Code saves an MCP result over 50,000 characters to a file unless the
 * tool raises the limit (up to 500,000) with this _meta key. A script keeps a
 * result in a variable instead of the model's context, so byob raises it.
 */
export const MAX_RESULT_META = { 'anthropic/maxResultSizeChars': 500_000 };

/** Under MAX_RESULT_META, with room for the notice and the truncation note. */
export const JSON_BUDGET = 400_000;

const isPlain = (v: unknown): v is R => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Drop internal fields (`_b64Data`, `_diffB64`, …) at any depth. */
export function clean(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(clean);
  if (!isPlain(v)) return v;
  const out: R = {};
  for (const [k, x] of Object.entries(v)) if (!k.startsWith('_') && x !== undefined) out[k] = clean(x);
  return out;
}

/** An error envelope as the object a script finds in `e.detail`. */
export function errorData(e: R): R {
  const out: R = { error: e.error, message: e.message };
  if (e.hint) out.hint = e.hint;
  for (const [k, v] of Object.entries(e)) {
    if (!(k in out) && !k.startsWith('_') && v !== undefined) out[k] = v;
  }
  if (e._originalError) out.originalError = e._originalError;
  return out;
}

function shrink(v: unknown, maxString: number, maxItems: number): unknown {
  if (typeof v === 'string') return v.length > maxString ? `${v.slice(0, maxString)}… [${v.length - maxString} more chars]` : v;
  if (Array.isArray(v)) return v.slice(0, maxItems).map((x) => shrink(x, maxString, maxItems));
  if (isPlain(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shrink(x, maxString, maxItems)]));
  return v;
}

/**
 * Serialize for a script. Over budget, the whole result goes to a file and
 * the reply keeps its shape with long strings and arrays cut, plus
 * `_truncated: {file, chars}` saying where the rest is.
 */
export function fitJson(tool: string, data: unknown, max = JSON_BUDGET): string {
  const full = JSON.stringify(data) ?? 'null';
  if (full.length <= max) return full;
  const file = saveOutput(tool.replace(/^browser_/, ''), full, 'json');
  const note = { file, chars: full.length, note: 'Long strings and arrays were cut to fit; the whole result is in file.' };
  for (let i = 0; i < 16; i++) {
    const str = Math.max(200, Math.floor(max / 2 / 2 ** i));
    const items = Math.max(1, Math.floor(5000 / 2 ** i));
    const cut = shrink(data, str, items);
    const out = JSON.stringify(isPlain(cut) ? { ...cut, _truncated: note } : { value: cut, _truncated: note });
    if (out.length <= max) return out;
  }
  return JSON.stringify({ _truncated: { ...note, note: 'Too large to return inline; the whole result is in file.' } });
}
