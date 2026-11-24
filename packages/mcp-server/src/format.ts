/**
 * Text rendering of tool results.
 *
 * The extension returns structured JSON; the model reads plain text. JSON
 * escaping alone roughly doubles the token cost of a snapshot (every quote
 * becomes \", every newline \n), so results are rendered here into compact,
 * readable text with the facts the agent needs next.
 */
import { saveBase64, saveOutput } from './files.js';
import { cookieHeader, saveCookieJar, type CookieRow } from './cookies.js';
import { clean } from './json-output.js';

export interface Rendered {
  text: string;
  images?: Array<{ data: string; mimeType: string }>;
  /**
   * The result for a script (JSON output, mode.ts) when it isn't simply the
   * extension's result minus internal fields — e.g. it names a file written here.
   */
  data?: Record<string, any>;
}

type R = Record<string, any>;

const DEFAULT_BUDGET = Number(process.env.BYOB_MAX_OUTPUT ?? 30_000);

/** Keep the model's context bounded; park the rest on disk. */
export function budget(tool: string, text: string, max = DEFAULT_BUDGET): string {
  if (text.length <= max) return text;
  const file = saveOutput(tool.replace(/^browser_/, ''), text);
  const head = text.slice(0, max);
  const cut = head.lastIndexOf('\n');
  return `${cut > max * 0.8 ? head.slice(0, cut) : head}\n\n[… output truncated at ${max} of ${text.length} chars — full text: ${file}]`;
}

export function tabLine(r: R): string {
  const title = r.title ? ` · ${r.title}` : '';
  return `Tab ${r.tabId}${title}\nURL: ${r.url ?? ''}`;
}

export function effectsLines(e: R | undefined): string[] {
  if (!e) return [];
  const out: string[] = [];
  if (e.navigated) {
    out.push(
      e.navigated.sameDocument
        ? `→ URL changed to ${e.navigated.url}`
        : `→ navigated to ${e.navigated.url}${e.navigated.title ? ` — "${e.navigated.title}"` : ''}${e.stillLoading ? ' (still loading)' : ''}`,
    );
  }
  for (const t of e.newTabs ?? []) out.push(`→ opened new tab ${t.tabId}: ${t.url || '(loading)'} — use tabId ${t.tabId} to work in it`);
  if (e.dialog) out.push(`→ ${e.dialog.type} dialog is open: "${e.dialog.message}" — answer it with browser_dialog`);
  for (const d of e.downloads ?? []) {
    out.push(d.state === 'complete' && d.path
      ? `→ downloaded ${d.filename}${d.bytes !== undefined ? ` (${fmtSize(d.bytes)})` : ''} → ${d.path}`
      : d.state === 'interrupted'
        ? `→ download of ${d.filename} failed`
        : `→ download started: ${d.filename} — browser_downloads (wait) gives its path when done`);
  }
  return out;
}

/** 12 B · 3 KB · 4.2 MB */
export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** The extension's snapshot depth limit when maxDepth isn't given. */
const DEFAULT_MAX_DEPTH = 12;

/**
 * A snapshot cut for size already ends with a "more nodes not shown" line;
 * one cut at maxDepth says nothing, so the model wouldn't know to dig.
 */
function truncationNote(s: R, maxDepth: number | null): string {
  if (!s.truncated || /more nodes not shown/.test(s.text ?? '')) return '';
  const at = maxDepth === null ? 'the depth limit' : `maxDepth ${maxDepth}`;
  return `\n[… deeper content cut at ${at} — raise maxDepth or scope with ref/selector]`;
}

export function snapshotBlock(s: R | undefined): string {
  if (!s) return '';
  if (s.diff) {
    if (s.diff.unchanged) return `\nPage unchanged since snapshot v${s.diff.base}.`;
    return `\nChanges since snapshot v${s.diff.base} (+${s.diff.added} −${s.diff.removed}):\n${s.text}`;
  }
  // Snapshots after actions reuse the last snapshot's options: depth unknown here.
  return `\n${tabLine(s)}\n${s.text}${truncationNote(s, null)}`;
}

/** Scroll results describe the position in their summary. */
export function renderAction(r: R): Rendered {
  const lines = [`${r.summary} (tab ${r.tabId})`, ...effectsLines(r.effects), ...snapshotErrorLine(r)];
  return { text: lines.join('\n') + snapshotBlock(r.snapshot) };
}

/** snapshot:true was asked for but couldn't be taken (page blocked, still loading …). */
function snapshotErrorLine(r: R): string[] {
  return r.snapshotError ? [`(snapshot:true failed: ${r.snapshotError})`] : [];
}

export function renderSnapshot(r: R, args: R = {}): Rendered {
  const head = tabLine(r);
  if (r.diff) {
    if (r.diff.unchanged) return { text: `${head}\nNo changes since snapshot v${r.diff.base} (now v${r.version}).` };
    return { text: `${head}\nChanges since snapshot v${r.diff.base} → v${r.version} (+${r.diff.added} −${r.diff.removed}):\n${r.text}` };
  }
  return { text: `${head}\n${r.text}${truncationNote(r, args.maxDepth ?? DEFAULT_MAX_DEPTH)}` };
}

export function renderFind(r: R): Rendered {
  const list = (r.matches ?? []) as Array<{ ref: string; role: string; name: string }>;
  const lines = list.length
    ? list.map((m) => `- ${m.role || 'element'}${m.name ? ` ${JSON.stringify(m.name)}` : ''} [ref=${m.ref}]`)
    : ['No matches.'];
  if (r.summary) return { text: `${r.summary} (tab ${r.tabId})\n${[...effectsLines(r.effects), ...snapshotErrorLine(r)].join('\n')}${snapshotBlock(r.snapshot)}\nMatches:\n${lines.join('\n')}`.replace(/\n\n+/g, '\n') };
  return { text: `${list.length} match(es) in tab ${r.tabId}:\n${lines.join('\n')}` };
}

const DEFAULT_READ_CHARS = 20_000;

/** Links honour filter and maxChars like the other formats. */
function renderLinks(r: R, args: R): string {
  let links = (r.links ?? []) as Array<{ text: string; url: string }>;
  const total = links.length;
  const needle = typeof args.filter === 'string' ? args.filter.toLowerCase() : '';
  if (needle) links = links.filter((l) => `${l.text} ${l.url}`.toLowerCase().includes(needle));
  const max = args.maxChars ?? DEFAULT_READ_CHARS;
  const lines: string[] = [];
  let chars = 0;
  for (const l of links) {
    const line = `- ${l.text || '(no text)'} → ${l.url}`;
    if (chars + line.length > max && lines.length) break;
    lines.push(line);
    chars += line.length + 1;
  }
  const count = needle ? `${links.length} of ${total} links match "${args.filter}"` : `${total} links`;
  const more = links.length > lines.length
    ? `\n… ${links.length - lines.length} more links (${needle ? 'raise maxChars' : 'use filter'}, or scope with ref/selector)`
    : '';
  return `${count}:\n${lines.join('\n')}${more}`;
}

export function renderRead(r: R, args: R = {}): Rendered {
  const data = typeof args.filter === 'string' ? readData(r, args) : undefined;
  if (Array.isArray(r.pages)) return { text: renderPages(r, args), data };
  return { text: `${tabLine(r)}\n${readBody(r, args)}`, data };
}

/** filter on links happens here, so scripts get the filtered list as well. */
function readData(r: R, args: R): R {
  const needle = String(args.filter).toLowerCase();
  const one = (p: R): R => {
    if (!Array.isArray(p.links)) return p;
    const links = (p.links as Array<{ text: string; url: string }>).filter((l) => `${l.text} ${l.url}`.toLowerCase().includes(needle));
    return { ...p, links, totalLinks: p.links.length };
  };
  const c = clean(r) as R;
  return Array.isArray(c.pages) ? { ...c, pages: c.pages.map(one) } : one(c);
}

/** One page's content under its header line (shared by single and multi-URL reads). */
function readBody(r: R, args: R): string {
  if (r.format === 'links') return renderLinks(r, args);
  const meta = [
    r.format,
    r.source && r.source !== 'page' ? `source: ${r.source}` : '',
    r.pdfPages ? `${r.pdfPages} page${r.pdfPages === 1 ? '' : 's'}` : '',
    `${r.totalChars ?? r.text?.length ?? 0} chars`,
  ].filter(Boolean).join(', ');
  const note = r.note ? `\n(${r.note})` : '';
  const trunc = r.truncated ? '\n[… truncated — raise maxChars, use outline:true / filter, or scope with ref/selector]' : '';
  return `(${meta})${note}\n\n${r.text ?? ''}${trunc}`;
}

/** browser_read {urls}: one section per page, in the order asked. */
function renderPages(r: R, args: R): string {
  const pages = r.pages as R[];
  const failed = pages.filter((p) => p.error).length;
  const head = `Read ${pages.length - failed} of ${pages.length} page(s) (up to ${r.perPageChars} chars each; tabs closed).`;
  const sections = pages.map((p, i) => {
    const title = p.title ? ` · ${p.title}` : '';
    if (p.error) return `=== ${i + 1}. ${p.requested ?? p.url}\nError: ${p.error}`;
    return `=== ${i + 1}. ${p.url}${title}\n${readBody(p, args)}`;
  });
  return `${head}\n\n${sections.join('\n\n')}`;
}

export function renderScreenshot(r: R, args: R): Rendered {
  if (r.unchanged) return { text: `Screenshot skipped: the ${r.what ?? 'page'} looks the same as the last one (tab ${r.tabId}).` };
  if (r.format === 'pdf') {
    const file = saveBase64('pdfs', 'pdf', r._b64Data, args.savePath);
    return { text: `Saved PDF of tab ${r.tabId} (${Math.round(r.bytes / 1024)} KB): ${file}`, data: { ...(clean(r) as R), path: file } };
  }
  const ext = r.format === 'jpeg' ? 'jpg' : 'png';
  const file = saveBase64('screenshots', ext, r._b64Data, args.savePath);
  const inline = args.inline ?? !args.fullPage;
  const legend = r.legend?.length
    ? `\nLabels: ${(r.legend as Array<{ ref: string; role: string; name: string }>).map((l) => `${l.ref}=${l.role}${l.name ? ` "${l.name.slice(0, 40)}"` : ''}`).join(', ')}`
    : '';
  return {
    text: `Screenshot of ${r.what} (${r.width}×${r.height}, tab ${r.tabId}) saved to ${file}${legend}${diffLines(r.diff)}`,
    // With diff:true the inline image is the new shot with changes highlighted.
    images: inline ? [{ data: r._diffB64 ?? r._b64Data, mimeType: r.mimeType }] : undefined,
    data: { ...(clean(r) as R), path: file },
  };
}

function diffLines(d: R | undefined): string {
  if (!d) return '';
  if (d.baseline) return '\nDiff: no earlier screenshot of this tab — this one is the baseline for the next diff:true.';
  if (d.sizeMismatch) {
    return `\nDiff: can't compare — the previous screenshot was ${d.prev.width}×${d.prev.height} (${d.prev.what}), this one is ${d.width}×${d.height}. Showing the plain screenshot.`;
  }
  const ago = Math.max(1, Math.round(d.sinceMs / 1000));
  if (!d.boxes.length) return `\nDiff: 0% of pixels changed since the previous screenshot (${ago}s ago).`;
  const boxes = (d.boxes as R[]).map((b, i) => `${i + 1}) x=${b.x} y=${b.y} ${b.w}×${b.h}`).join(', ');
  const more = d.regions > d.boxes.length ? ` (+${d.regions - d.boxes.length} smaller)` : '';
  return `\nDiff: ${d.percent}% of pixels changed since the previous screenshot (${ago}s ago), highlighted in the image. Regions (CSS px in the captured area): ${boxes}${more}`;
}

const ENDED_EARLY: Record<string, string> = {
  tab_closed: 'the tab was closed',
  detached: 'the debugger was detached (DevTools opened, or Chrome\'s debugging bar was cancelled)',
  size_cap: 'it reached the 40 MB size cap',
  max_duration: 'it reached the 10-minute cap',
  error: 'the encoder failed',
};

export function renderRecord(r: R, args: R): Rendered {
  if (r.recording) {
    return { text: `Recording tab ${r.tabId} at ${r.fps} fps (id ${r.id}). Act, then browser_record {action:"stop", id:"${r.id}"}.\n${tabLine(r)}` };
  }
  const file = saveBase64('recordings', 'webm', r._b64Data, args.savePath);
  const early = ENDED_EARLY[r.endedEarly as string];
  return {
    data: { ...(clean(r) as R), path: file },
    text: `Saved ${(r.durationMs / 1000).toFixed(1)} s video of tab ${r.tabId} (${Math.max(1, Math.round(r.bytes / 1024))} KB, ${r.frames} frames) to ${file}${early ? `\nStopped early: ${early}.` : ''}`,
  };
}

export function renderTabs(r: R, args: R, working?: number): Rendered {
  if (r.tabs) {
    const lines = (r.tabs as R[]).map((t) => {
      const marks = [t.tabId === working ? 'working' : '', t.active ? 'active' : '', t.agent ? 'byob' : '']
        .filter(Boolean).join(', ');
      return `${t.tabId === working ? '▶' : '-'} [${t.tabId}] ${t.title || '(untitled)'} — ${t.url}${marks ? ` (${marks})` : ''}`;
    });
    const hidden = r.hiddenByPolicy ? `\n(${r.hiddenByPolicy} tab(s) hidden by host policy)` : '';
    const data = { ...(clean(r) as R), tabs: (r.tabs as R[]).map((t) => (t.tabId === working ? { ...t, working: true } : t)) };
    return { text: `${lines.length} tabs:\n${lines.join('\n')}${hidden}`, data };
  }
  if (r.history) {
    const lines = (r.history as R[]).map((h) => `- ${h.lastVisit.slice(0, 16).replace('T', ' ')} ${h.title || '(untitled)'} — ${h.url}`);
    return { text: `${lines.length} history entries:\n${lines.join('\n')}` };
  }
  if (r.closed) return { text: `Closed tab ${r.tabId} (${r.url})` };
  const verb = args.action === 'new' ? 'Opened' : 'Selected';
  return { text: `${verb} tab ${r.tabId} — now the working tab\n${tabLine(r)}` };
}

export function renderNavigate(r: R): Rendered {
  const lines = [`${r.opened ? 'Opened new tab' : 'Navigated'}: ${tabLine(r)}`];
  if (r.stillLoading) lines.push('(still loading — use browser_wait if you need it complete)');
  return { text: lines.join('\n') + snapshotBlock(r.snapshot) };
}

export function renderConsole(r: R): Rendered {
  const entries = (r.entries ?? []) as R[];
  const lines = entries.map((e) => `[${e.seq}] ${e.level.toUpperCase().padEnd(5)} ${e.source !== 'console' ? `(${e.source}) ` : ''}${e.text}${e.location ? `  @ ${e.location}` : ''}`);
  const more = r.dropped ? `\n(${r.dropped} older entries omitted)` : '';
  const reset = r.reset ? '(byob restarted since your `since` cursor — showing everything it has.)\n' : '';
  return {
    text: `${reset}${entries.length ? lines.join('\n') : 'No console messages.'}${more}\nNext time pass since:${r.lastSeq} to get only newer messages.`,
  };
}

const HANDOFF: Record<string, string> = {
  done: 'The user is done',
  declined: "The user can't do it — ask them what to do next",
  pending: 'Still waiting for the user (call again to keep waiting)',
  tab_closed: 'The user closed the tab',
};

export function renderWait(r: R): Rendered {
  if (r.user) {
    const where = r.url ? `: ${r.title ? `${r.title} — ` : ''}${r.url}` : '';
    return { text: `${HANDOFF[r.user] ?? r.user}${where} (tab ${r.tabId}, ${(r.waitedMs / 1000).toFixed(0)}s)` };
  }
  return { text: `Waited ${(r.waitedMs / 1000).toFixed(1)}s — ${r.satisfied.length ? r.satisfied.join('; ') : 'done'} (tab ${r.tabId})` };
}

export function renderEvaluate(r: R): Rendered {
  const v = r.value === undefined ? 'undefined' : typeof r.value === 'string' ? r.value : JSON.stringify(r.value, null, 2);
  return { text: `${r.valueType}: ${v}` };
}

export function renderStorage(r: R, args: R = {}): Rendered {
  if (r.set) return { text: `Set ${r.kind}: ${[].concat(r.set).join(', ')}` };
  if (r.cleared !== undefined) return { text: `Cleared ${r.cleared} ${r.kind} entr${r.cleared === 1 ? 'y' : 'ies'}` };
  if (r.kind === 'cookies') {
    const list = (r.cookies ?? []) as CookieRow[];
    const lines = list.map((c) => `${c.name}=${c.value}  (${c.domain}${c.path}${c.httpOnly ? ', httpOnly' : ''}${c.secure ? ', secure' : ''}${c.expires ? `, expires ${new Date(c.expires * 1000).toISOString().slice(0, 10)}` : ', session'})`);
    // Ready for curl -H; a domain scope can mix cookies of different paths.
    const header = list.length ? `\n\nFor curl -H:\n${cookieHeader(list)}` : '';
    const jarPath = args.savePath ? saveCookieJar(args.savePath, list) : undefined;
    const jar = jarPath
      ? `\n\nSaved ${list.length} cookie(s) as a Netscape cookies.txt (curl -b, wget --load-cookies, yt-dlp --cookies) to ${jarPath} — it holds session secrets; delete it when done.`
      : '';
    const data = { ...(clean(r) as R), ...(list.length ? { header: cookieHeader(list) } : {}), ...(jarPath ? { cookieJar: jarPath } : {}) };
    return { text: `${list.length} cookie(s) for ${r.scope}:\n${lines.join('\n')}${header}${jar}`, data };
  }
  const items = r.items ?? {};
  const keys = Object.keys(items);
  return { text: `${r.kind}Storage of ${r.origin} — ${keys.length} key(s):\n${keys.map((k) => `${k} = ${items[k]}`).join('\n')}` };
}

export function renderNetwork(r: R, args: R): Rendered {
  switch (r.action) {
    case 'record':
      return { text: `Recording network on tab ${r.tabId} (id ${r.id}). Do the actions, then browser_network {action:"stop", id:"${r.id}"}.` };
    case 'intercept':
      return { text: `Intercepting on tab ${r.tabId} with ${r.rules} rule(s) (id ${r.id}). Stop with browser_network {action:"unintercept", id:"${r.id}"}.` };
    case 'unintercept': {
      const hits = (r.hitsByRule ?? []) as R[];
      return { text: `Stopped intercept ${r.interceptId}: ${r.totalRequests} request(s) matched.\n${hits.map((h) => `rule ${h.ruleIndex}: ${h.count} hit(s)${h.sampleUrls?.length ? ` e.g. ${h.sampleUrls[0]}` : ''}`).join('\n')}` };
    }
    case 'stop': {
      const records = (r.records ?? []) as R[];
      const w = r.waited as { wanted: number; got: number; timedOut: boolean } | undefined;
      const waitNote = w && w.got < w.wanted
        ? `\nOnly ${w.got} of ${w.wanted} matching request(s) finished${w.timedOut ? ` within ${args.timeoutSec ?? 30}s` : ' before the recording ended'}.`
        : '';
      const head = `Recorded ${r.recordCount ?? records.length} request(s) in ${Math.round((r.durationMs ?? 0) / 1000)}s (ended: ${r.endedReason})${r.truncated ? ', truncated' : ''}.${waitNote}`;
      // Scripts get the records themselves; the HAR only as a file.
      const { har, ...rest } = r;
      const data = clean(rest) as R;
      if (args.format === 'har' || args.format === 'json') {
        const payload = args.format === 'har' ? har : records;
        const file = saveOutput('network', JSON.stringify(payload, null, 2), args.format === 'har' ? 'har' : 'json');
        return { text: `${head}\nSaved ${args.format.toUpperCase()}: ${file}`, data: { ...data, path: file } };
      }
      const lines = records.slice(0, 200).map((x) => {
        const status = x.failed ? `FAILED ${x.errorText ?? ''}`.trim() : String(x.responseStatus ?? '—');
        const size = x.responseBody ? `, ${x.responseBody.length}B body` : '';
        const ms = x.timing?.durationMs !== undefined ? `, ${Math.round(x.timing.durationMs)}ms` : '';
        return `${x.method} ${status} ${x.url}  [${x.resourceType}${size}${ms}]`;
      });
      const more = records.length > 200 ? `\n… ${records.length - 200} more (use format:"json")` : '';
      return { text: `${head}\n${lines.join('\n')}${more}${w ? waitedBodies(records, w.wanted) : ''}\nFull bodies: stop with format:"json" or "har".`, data };
    }
  }
  return { text: JSON.stringify(r) };
}

const BODY_PREVIEW_CHARS = 2000;

/** stop {waitFor}: the point was the reply, so show the first finished ones' bodies. */
function waitedBodies(records: R[], wanted: number): string {
  const done = records.filter((x) => x.resourceType !== 'websocket' && x.timing?.endTime !== undefined && !x.failed);
  return done.slice(0, Math.min(wanted, 3)).map((x) => {
    const body = typeof x.responseBody === 'string' ? x.responseBody : '';
    const shown = x.responseBodyEncoding === 'base64'
      ? `(binary, ${body.length} base64 chars)`
      : body.length > BODY_PREVIEW_CHARS ? `${body.slice(0, BODY_PREVIEW_CHARS)}… (${body.length} chars)` : body || '(empty)';
    return `\n\n${x.method} ${x.url} → ${x.responseStatus ?? '—'}\n${shown}`;
  }).join('');
}

export function renderGeneric(r: R): Rendered {
  const { tabId, ...rest } = r;
  const text = Object.entries(rest)
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join('\n');
  return { text: tabId !== undefined ? `tab ${tabId}\n${text}` : text };
}

export function renderError(e: R): string {
  const lines = [`Error [${e.error}]: ${e.message}`];
  if (e.hint) lines.push(`Hint: ${e.hint}`);
  if (e.exceptionDetails?.lineNumber !== undefined) lines.push(`at line ${e.exceptionDetails.lineNumber + 1}`);
  if (e._originalError) lines.push(`(original code: ${e._originalError})`);
  return lines.join('\n');
}
