import { ExtractTableInput } from '@byob/shared';
import { openOrReuse } from '../tab.js';
import { checkUrlAllowed, urlForbiddenError } from '../url-guard.js';

export interface ExtractedTable {
  selector: string;
  headers: string[];
  rows: string[][] | Record<string, string>[];
  rowCount: number;
}

// Runs in the page's ISOLATED world. Pure: no closures over outer vars.
// NOTE: this body is serialized and executed in the page context where DOM
// globals exist; the SW-side tsconfig has no `dom` lib, so we access them
// via `globalThis` to keep typecheck happy.
function extractTablesInPage(
  selector: string,
  format: 'rows' | 'objects',
): { selector: string; headers: string[]; rows: unknown[]; rowCount: number }[] {
  // Minimal local DOM-ish typings — only what this function touches.
  interface El {
    textContent: string | null;
    querySelectorAll(s: string): ArrayLike<El> & Iterable<El>;
    querySelector(s: string): El | null;
  }
  interface HTMLEl extends El {
    innerText: string;
  }
  interface Doc {
    querySelectorAll(s: string): ArrayLike<El> & Iterable<El>;
  }
  const g = globalThis as unknown as {
    document: Doc;
    HTMLTableElement: { new (): unknown };
  };

  function cellText(el: El): string {
    const v = (el as HTMLEl).innerText;
    const t = typeof v === 'string' && v.length > 0 ? v : el.textContent ?? '';
    return t.replace(/\s+/g, ' ').trim();
  }

  function rowCells(tr: El): string[] {
    const out: string[] = [];
    const cells = tr.querySelectorAll(':scope > th, :scope > td');
    for (const c of cells) out.push(cellText(c));
    return out;
  }

  const tables = g.document.querySelectorAll(selector);
  const out: { selector: string; headers: string[]; rows: unknown[]; rowCount: number }[] = [];
  let i = 0;
  for (const t of tables) {
    if (!(t instanceof g.HTMLTableElement)) {
      continue;
    }
    let headerCells: string[] = [];
    const theadTr = t.querySelector(':scope > thead > tr');
    if (theadTr) {
      headerCells = rowCells(theadTr);
    }
    const bodyTrs: El[] = [];
    const tbodies = t.querySelectorAll(':scope > tbody');
    if (tbodies.length > 0) {
      for (const tb of tbodies) {
        for (const tr of tb.querySelectorAll(':scope > tr')) bodyTrs.push(tr);
      }
    } else {
      const trs = Array.from(t.querySelectorAll(':scope > tr'));
      if (headerCells.length === 0 && trs.length > 0 && trs[0]) {
        headerCells = rowCells(trs[0]);
        for (let k = 1; k < trs.length; k++) bodyTrs.push(trs[k]!);
      } else {
        for (const tr of trs) bodyTrs.push(tr);
      }
    }

    const rawRows: string[][] = bodyTrs.map(rowCells);

    let rows: unknown[];
    if (format === 'objects' && headerCells.length > 0) {
      rows = rawRows.map((r) => {
        const o: Record<string, string> = {};
        for (let c = 0; c < headerCells.length; c++) {
          const key = headerCells[c] ?? `col${c}`;
          o[key] = r[c] ?? '';
        }
        return o;
      });
    } else {
      rows = rawRows;
    }

    out.push({
      selector: `${selector}:nth-of-type(${i + 1})`,
      headers: headerCells,
      rows,
      rowCount: rawRows.length,
    });
    i += 1;
  }
  return out;
}

export async function handleExtractTable(rawParams: unknown): Promise<unknown> {
  const params = ExtractTableInput.parse(rawParams);

  if (params.url) {
    const guard = checkUrlAllowed(params.url);
    if (!guard.ok) return urlForbiddenError(guard.reason);
  }
  const tab = await openOrReuse({ url: params.url, tabId: params.tabId });

  try {
    let result: ExtractedTable[] = [];
    try {
      const [exec] = await chrome.scripting.executeScript({
        target: { tabId: tab.tabId },
        world: 'ISOLATED',
        func: extractTablesInPage,
        args: [params.selector, params.format],
      });
      result = (exec?.result as ExtractedTable[] | undefined) ?? [];
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/Cannot access|chrome-extension|Frame|target/i.test(msg)) {
        return {
          error: 'url_forbidden',
          message:
            'Cannot extract tables on special pages or pages where scripting is blocked.',
          hint: 'Use a regular http(s):// url.',
        };
      }
      return {
        error: 'unknown',
        message: `executeScript failed: ${msg}`,
      };
    }

    const tabInfo = await chrome.tabs.get(tab.tabId);
    return {
      tables: result,
      tabId: tab.tabId,
      url: tabInfo.url ?? params.url ?? '',
    };
  } finally {
    if (!tab.reused) {
      await tab.cleanup();
    }
  }
}
