/**
 * Text rendering of tool results.
 *
 * The extension returns structured JSON; the model reads plain text. JSON
 * escaping alone roughly doubles the token cost of a snapshot (every quote
 * becomes \", every newline \n), so results are rendered here into compact,
 * readable text with the facts the agent needs next.
 */
import { saveBase64, saveOutput } from './files.js';

export interface Rendered {
  text: string;
  images?: Array<{ data: string; mimeType: string }>;
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
  return out;
}

export function snapshotBlock(s: R | undefined): string {
  if (!s) return '';
  if (s.diff) {
    if (s.diff.unchanged) return `\nPage unchanged since snapshot v${s.diff.base}.`;
    return `\nChanges since snapshot v${s.diff.base} (+${s.diff.added} −${s.diff.removed}):\n${s.text}`;
  }
  return `\n${tabLine(s)}\n${s.text}${s.truncated ? '\n[snapshot truncated — use interactive:true or scope it]' : ''}`;
}

export function renderAction(r: R): Rendered {
  const lines = [`${r.summary} (tab ${r.tabId})`, ...effectsLines(r.effects)];
  if (r.scroll) {/* summary already describes scroll position */}
  return { text: lines.join('\n') + snapshotBlock(r.snapshot) };
}

export function renderSnapshot(r: R): Rendered {
  const head = tabLine(r);
  if (r.diff) {
    if (r.diff.unchanged) return { text: `${head}\nNo changes since snapshot v${r.diff.base} (now v${r.version}).` };
    return { text: `${head}\nChanges since snapshot v${r.diff.base} → v${r.version} (+${r.diff.added} −${r.diff.removed}):\n${r.text}` };
  }
  const tail = r.truncated ? '' : '';
  return { text: `${head}\n${r.text}${tail}` };
}

export function renderFind(r: R): Rendered {
  const list = (r.matches ?? []) as Array<{ ref: string; role: string; name: string }>;
  const lines = list.length
    ? list.map((m) => `- ${m.role || 'element'}${m.name ? ` ${JSON.stringify(m.name)}` : ''} [ref=${m.ref}]`)
    : ['No matches.'];
  if (r.summary) return { text: `${r.summary} (tab ${r.tabId})\n${effectsLines(r.effects).join('\n')}${snapshotBlock(r.snapshot)}\nMatches:\n${lines.join('\n')}`.replace(/\n\n+/g, '\n') };
  return { text: `${list.length} match(es) in tab ${r.tabId}:\n${lines.join('\n')}` };
}

export function renderRead(r: R): Rendered {
  const head = tabLine(r);
  if (r.format === 'links') {
    const links = (r.links ?? []) as Array<{ text: string; url: string }>;
    return { text: `${head}\n${links.length} links:\n${links.map((l) => `- ${l.text || '(no text)'} → ${l.url}`).join('\n')}` };
  }
  const meta = [r.format, r.source && r.source !== 'page' ? `source: ${r.source}` : '', `${r.totalChars ?? r.text?.length ?? 0} chars`]
    .filter(Boolean).join(', ');
  const trunc = r.truncated ? '\n[… truncated — raise maxChars, use outline:true / filter, or scope with ref/selector]' : '';
  return { text: `${head}\n(${meta})\n\n${r.text ?? ''}${trunc}` };
}

export function renderScreenshot(r: R, args: R): Rendered {
  if (r.unchanged) return { text: `Screenshot skipped: the ${r.what ?? 'page'} looks the same as the last one (tab ${r.tabId}).` };
  if (r.format === 'pdf') {
    const file = saveBase64('pdfs', 'pdf', r._b64Data, args.savePath);
    return { text: `Saved PDF of tab ${r.tabId} (${Math.round(r.bytes / 1024)} KB): ${file}` };
  }
  const ext = r.format === 'jpeg' ? 'jpg' : 'png';
  const file = saveBase64('screenshots', ext, r._b64Data, args.savePath);
  const inline = args.inline ?? !args.fullPage;
  const legend = r.legend?.length
    ? `\nLabels: ${(r.legend as Array<{ ref: string; role: string; name: string }>).map((l) => `${l.ref}=${l.role}${l.name ? ` "${l.name.slice(0, 40)}"` : ''}`).join(', ')}`
    : '';
  return {
    text: `Screenshot of ${r.what} (${r.width}×${r.height}, tab ${r.tabId}) saved to ${file}${legend}`,
    images: inline ? [{ data: r._b64Data, mimeType: r.mimeType }] : undefined,
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
    return { text: `${lines.length} tabs:\n${lines.join('\n')}${hidden}` };
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
  return {
    text: `${entries.length ? lines.join('\n') : 'No console messages.'}${more}\nNext time pass since:${r.lastSeq} to get only newer messages.`,
  };
}

export function renderWait(r: R): Rendered {
  return { text: `Waited ${(r.waitedMs / 1000).toFixed(1)}s — ${r.satisfied.length ? r.satisfied.join('; ') : 'done'} (tab ${r.tabId})` };
}

export function renderEvaluate(r: R): Rendered {
  const v = r.value === undefined ? 'undefined' : typeof r.value === 'string' ? r.value : JSON.stringify(r.value, null, 2);
  return { text: `${r.valueType}: ${v}` };
}

export function renderStorage(r: R): Rendered {
  if (r.set) return { text: `Set ${r.kind}: ${[].concat(r.set).join(', ')}` };
  if (r.cleared !== undefined) return { text: `Cleared ${r.cleared} ${r.kind} entr${r.cleared === 1 ? 'y' : 'ies'}` };
  if (r.kind === 'cookies') {
    const list = (r.cookies ?? []) as R[];
    const lines = list.map((c) => `${c.name}=${c.value}  (${c.domain}${c.path}${c.httpOnly ? ', httpOnly' : ''}${c.secure ? ', secure' : ''}${c.expires ? `, expires ${new Date(c.expires * 1000).toISOString().slice(0, 10)}` : ', session'})`);
    return { text: `${list.length} cookie(s) for ${r.scope}:\n${lines.join('\n')}` };
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
      const head = `Recorded ${r.recordCount ?? records.length} request(s) in ${Math.round((r.durationMs ?? 0) / 1000)}s (ended: ${r.endedReason})${r.truncated ? ', truncated' : ''}.`;
      if (args.format === 'har' || args.format === 'json') {
        const payload = args.format === 'har' ? r.har : records;
        const file = saveOutput('network', JSON.stringify(payload, null, 2), args.format === 'har' ? 'har' : 'json');
        return { text: `${head}\nSaved ${args.format.toUpperCase()}: ${file}` };
      }
      const lines = records.slice(0, 200).map((x) => {
        const status = x.failed ? `FAILED ${x.errorText ?? ''}`.trim() : String(x.responseStatus ?? '—');
        const size = x.responseBody ? `, ${x.responseBody.length}B body` : '';
        const ms = x.timing?.durationMs !== undefined ? `, ${Math.round(x.timing.durationMs)}ms` : '';
        return `${x.method} ${status} ${x.url}  [${x.resourceType}${size}${ms}]`;
      });
      const more = records.length > 200 ? `\n… ${records.length - 200} more (use format:"json")` : '';
      return { text: `${head}\n${lines.join('\n')}${more}\nFull bodies: stop with format:"json" or "har".` };
    }
  }
  return { text: JSON.stringify(r) };
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
