import { ReadMarkdownInput } from '@byob/shared';
import { tryAttachToTab } from '../cdp.js';
import { openOrReuse } from '../tab.js';
import { checkUrlAllowed, urlForbiddenError } from '../url-guard.js';
import { keepAwakeStart, keepAwakeEnd } from '../keepalive.js';
import {
  resolveFrame,
  evaluateInResolvedFrame,
  frameErrorToEnvelope,
} from '../frame-resolver.js';

// Function that runs in the page's ISOLATED world (default). Returns the
// full document HTML so the bridge can do Readability extraction.
// NOTE: this body is serialized and executed in the page context where DOM
// globals exist; the SW-side tsconfig has no `dom` lib, so we access them
// via `globalThis` to keep typecheck happy.
function snapshotOuterHtmlInPage(): { url: string; outerHTML: string } {
  const g = globalThis as unknown as {
    location: { href: string };
    document: { documentElement?: { outerHTML?: string } };
  };
  return {
    url: g.location.href,
    outerHTML: g.document.documentElement?.outerHTML ?? '',
  };
}

interface ReadabilityServerOk {
  ok: true;
  markdown: string;
  title?: string;
  byline?: string;
  excerpt?: string;
  lengthChars: number;
  truncated?: boolean;
}
interface ReadabilityServerErr {
  ok: false;
  code: 'readability_no_article' | 'html_parse_failed';
  htmlLength?: number;
  message?: string;
}

export async function handleReadMarkdown(rawParams: unknown): Promise<unknown> {
  const params = ReadMarkdownInput.parse(rawParams);

  // Bridge enriches params with these two before forwarding (see main.ts
  // readMarkdownRoute). Without them we cannot reach the local /readability
  // endpoint.
  const extra = rawParams as { readabilityEndpoint?: string; readabilitySecret?: string };
  const endpoint = typeof extra.readabilityEndpoint === 'string' ? extra.readabilityEndpoint : '';
  const secret = typeof extra.readabilitySecret === 'string' ? extra.readabilitySecret : '';
  if (!endpoint || !secret) {
    return {
      error: 'unknown',
      message: 'bridge did not provide readabilityEndpoint/readabilitySecret',
    };
  }

  if (params.url) {
    const guard = checkUrlAllowed(params.url);
    if (!guard.ok) return urlForbiddenError(guard.reason);
  }
  const tab = await openOrReuse({ url: params.url, tabId: params.tabId });

  keepAwakeStart();
  try {
    let snapshot: { url: string; outerHTML: string } | null = null;
    if (params.framePath.length === 0) {
      // Fast path: top-level frame uses chrome.scripting.executeScript
      // (no CDP attach needed, preserves v0.1 behavior).
      try {
        const [exec] = await chrome.scripting.executeScript({
          target: { tabId: tab.tabId },
          world: 'ISOLATED',
          func: snapshotOuterHtmlInPage,
        });
        snapshot = (exec?.result as { url: string; outerHTML: string } | null) ?? null;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/Cannot access|chrome-extension|Frame|target/i.test(msg)) {
          return {
            error: 'url_forbidden',
            message:
              'Cannot read markdown on special pages or pages where scripting is blocked.',
            hint: 'Use a regular http(s):// url.',
          };
        }
        return {
          error: 'unknown',
          message: `executeScript failed: ${msg}`,
        };
      }
    } else {
      // Cross-frame path: attach CDP, resolve the target frame, and grab
      // outerHTML from that frame's executionContext via Runtime.evaluate.
      const { session, reason } = await tryAttachToTab(tab.tabId);
      if (!session) {
        if (reason === 'special_page') {
          return {
            error: 'url_forbidden',
            message: 'Cannot read markdown on special pages (chrome://, devtools://, etc.).',
            hint: 'Use a regular http(s):// url.',
          };
        }
        if (reason === 'tab_gone') {
          return {
            error: 'tab_closed',
            message: 'Tab was closed before read_markdown could attach.',
          };
        }
        return {
          error: 'cdp_attach_failed',
          message: 'Could not attach Chrome debugger after 3 retries.',
          hint: 'Close DevTools (F12) on the target tab and retry.',
        };
      }
      let frame;
      try {
        frame = await resolveFrame(session, params.framePath);
      } catch (e) {
        const env = frameErrorToEnvelope(e);
        if (env) return env;
        throw e;
      }
      try {
        snapshot = await evaluateInResolvedFrame<{ url: string; outerHTML: string }>(
          session,
          frame,
          '({ url: location.href, outerHTML: document.documentElement ? document.documentElement.outerHTML : "" })',
          { awaitPromise: false, returnByValue: true },
        );
      } catch (e) {
        const env = frameErrorToEnvelope(e);
        if (env) return env;
        throw e;
      }
    }
    if (!snapshot || !snapshot.outerHTML) {
      return {
        error: 'html_parse_failed',
        message: 'Could not read page HTML (empty document).',
      };
    }

    const url = endpoint + '?secret=' + encodeURIComponent(secret);
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          html: snapshot.outerHTML,
          sourceUrl: snapshot.url,
          options: {
            includeMetadata: params.includeMetadata,
            includeImages: params.includeImages,
            preserveCode: params.preserveCode,
            maxLength: params.maxLength,
          },
        }),
      });
    } catch (e) {
      return {
        error: 'unknown',
        message: `fetch /readability failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    const data = (await resp.json()) as ReadabilityServerOk | ReadabilityServerErr;
    if (!data.ok) {
      if (data.code === 'readability_no_article') {
        return {
          error: 'readability_no_article',
          message: `Readability did not identify a main article (htmlLength=${data.htmlLength ?? 0}).`,
          hint: 'Fall back to browser_read for noisy / SPA pages.',
        };
      }
      return {
        error: 'html_parse_failed',
        message: data.message ?? 'HTML parse failed',
      };
    }

    const tabInfo = await chrome.tabs.get(tab.tabId);
    const out: Record<string, unknown> = {
      markdown: data.markdown,
      lengthChars: data.lengthChars,
      tabId: tab.tabId,
      url: tabInfo.url ?? snapshot.url,
    };
    if (params.includeMetadata) {
      if (data.title !== undefined) out.title = data.title;
      if (data.byline !== undefined) out.byline = data.byline;
      if (data.excerpt !== undefined) out.excerpt = data.excerpt;
    }
    if (data.truncated) out.truncated = true;
    return out;
  } finally {
    keepAwakeEnd();
    if (!tab.reused) {
      await tab.cleanup();
    }
  }
}
