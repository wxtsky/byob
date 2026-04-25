// URL pattern compiler used by record-network filter. Recognises two formats:
//   - /regex/flags  → JS RegExp
//   - anything else → glob with `*` (any chars including `/`) wildcard
//
// Returns null when pattern is empty/undefined; matchUrl(null, ...) always
// returns true so call sites don't have to special-case "no filter".

export type CompiledPattern = RegExp | null;

export function compileUrlPattern(pattern: string | undefined): CompiledPattern {
  if (!pattern) return null;
  // Regex form: /pattern/flags  (e.g. /api\/v\d+/i)
  const m = /^\/(.+)\/([a-z]*)$/.exec(pattern);
  if (m) {
    try {
      return new RegExp(m[1]!, m[2]);
    } catch {
      // fall through to glob — never throw out of a filter compiler
    }
  }
  // Glob form: escape regex specials, replace * with .*
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  try {
    return new RegExp('^' + escaped + '$');
  } catch {
    return null;
  }
}

export function matchUrl(pattern: CompiledPattern, url: string): boolean {
  if (pattern === null) return true;
  return pattern.test(url);
}
