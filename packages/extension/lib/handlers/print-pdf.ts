import { PrintPdfInput } from '@byob/shared';
import { tryAttachToTab } from '../cdp.js';
import { openOrReuse } from '../tab.js';
import { checkUrlAllowed, urlForbiddenError } from '../url-guard.js';
import { keepAwakeStart, keepAwakeEnd } from '../keepalive.js';
import { throwIfAborted } from '../signal-utils.js';
import { attachErrorEnvelope } from '../attach-error.js';

const PAPER_INCHES: Record<'A4' | 'Letter' | 'Legal', { width: number; height: number }> = {
  A4:     { width: 8.27, height: 11.69 },
  Letter: { width: 8.5,  height: 11 },
  Legal:  { width: 8.5,  height: 14 },
};

export async function handlePrintPdf(
  rawParams: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const params = PrintPdfInput.parse(rawParams);
  if (params.url) {
    const guard = checkUrlAllowed(params.url);
    if (!guard.ok) return urlForbiddenError(guard.reason);
  }
  throwIfAborted(signal);

  const tab = await openOrReuse({ url: params.url, tabId: params.tabId, signal });
  const attachResult = await tryAttachToTab(tab.tabId, signal);
  const { session } = attachResult;
  if (!session) {
    if (!tab.reused) await tab.cleanup();
    return attachErrorEnvelope(attachResult);
  }

  keepAwakeStart();
  try {
    const paper = PAPER_INCHES[params.paperFormat as keyof typeof PAPER_INCHES];
    const printArgs: Record<string, unknown> = {
      landscape: params.landscape,
      printBackground: params.printBackground,
      scale: params.scale,
      paperWidth: paper.width,
      paperHeight: paper.height,
      marginTop: params.margin,
      marginBottom: params.margin,
      marginLeft: params.margin,
      marginRight: params.margin,
      pageRanges: params.pageRanges,
      transferMode: 'ReturnAsStream',
    };

    const pdf = await session.send<{ data?: string; stream?: string }>(
      'Page.printToPDF',
      printArgs,
      signal,
    );
    if (!pdf.stream) {
      return { error: 'unknown', message: 'Page.printToPDF returned no stream handle' };
    }

    const handle = pdf.stream;
    const b64Chunks: string[] = [];
    try {
      while (true) {
        throwIfAborted(signal);
        const r = await session.send<{ data: string; eof: boolean; base64Encoded?: boolean }>(
          'IO.read',
          { handle, size: 256 * 1024 },
          signal,
        );
        if (r.data) {
          // The IO stream produced by Page.printToPDF is binary; CDP returns
          // base64Encoded:true. If we ever see utf8 (base64Encoded:false), the
          // PDF is non-recoverable in extension ctx (no Node Buffer here).
          // Bail loudly rather than silently writing a corrupted file.
          if (r.base64Encoded === false) {
            return {
              error: 'unknown',
              message: 'IO.read returned non-base64 PDF chunk; aborting to avoid corruption',
            };
          }
          b64Chunks.push(r.data);
        }
        if (r.eof) break;
      }
    } finally {
      try {
        await session.send('IO.close', { handle });
      } catch {
        // ignore close errors
      }
    }

    const tabInfo = await chrome.tabs.get(tab.tabId).catch(() => null);
    return {
      _b64Data: b64Chunks.join(''),
      _savePath: params.savePath ?? '',
      tabId: tab.tabId,
      url: tabInfo?.url ?? params.url ?? '',
    };
  } finally {
    keepAwakeEnd();
    if (!tab.reused) {
      await session.detach();
      await tab.cleanup();
    }
  }
}

