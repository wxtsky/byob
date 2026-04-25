// Pure HTML → markdown converter used by the /readability loopback HTTP
// endpoint. Kept as a separate module so unit tests can call htmlToMarkdown()
// directly without spinning up an HTTP server.
//
// Pipeline:
//   raw HTML  →  jsdom (build DOM)
//             →  Readability (extract article)  → metadata + cleaned HTML
//             →  turndown (HTML → markdown)
//             →  optional truncate
//
// Why bridge-side: extension (MV3) cannot bundle jsdom (Node-only). Bridge is
// already a Node process and already has a loopback HTTP server (upload-server)
// for similar oversize-payload cases (download-images). We piggy-back the
// /readability route on that same server (Task 3).

import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';

export interface ConvertOptions {
  includeMetadata: boolean;
  includeImages: boolean;
  preserveCode: boolean;
  maxLength?: number;
}

export interface ConvertResult {
  markdown: string;
  title?: string;
  byline?: string;
  excerpt?: string;
  lengthChars: number;
  truncated?: boolean;
}

export class ReadabilityNoArticleError extends Error {
  // Carry HTML length so callers / clients can decide whether to retry
  // with browser_read fallback.
  constructor(public readonly htmlLength: number) {
    super('Readability did not identify a main article');
    this.name = 'ReadabilityNoArticleError';
  }
}

function buildTurndown(opts: ConvertOptions): TurndownService {
  const td = new TurndownService({
    codeBlockStyle: opts.preserveCode ? 'fenced' : 'indented',
    headingStyle: 'atx',
    bulletListMarker: '-',
  });
  if (!opts.includeImages) {
    // Drop <img> entirely (no markdown emitted) and unwrap their parent <a>
    // when the only child was the image.
    td.addRule('drop-images', {
      filter: ['img'],
      replacement: () => '',
    });
  }
  return td;
}

export function htmlToMarkdown(rawHtml: string, opts: ConvertOptions, sourceUrl?: string): ConvertResult {
  // jsdom needs a base URL so relative URLs (img src, anchor href) resolve.
  // If the caller didn't pass one, fall back to about:blank — the Readability
  // article body just won't have working relative links, which is acceptable.
  const dom = new JSDOM(rawHtml, { url: sourceUrl ?? 'about:blank' });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();
  if (!article || !article.content) {
    throw new ReadabilityNoArticleError(rawHtml.length);
  }

  const td = buildTurndown(opts);
  let markdown = td.turndown(article.content).trim();

  let truncated: boolean | undefined;
  if (opts.maxLength && markdown.length > opts.maxLength) {
    markdown = markdown.slice(0, opts.maxLength) + '\n\n[truncated]\n';
    truncated = true;
  }

  const result: ConvertResult = {
    markdown,
    lengthChars: markdown.length,
  };
  if (opts.includeMetadata) {
    if (article.title) result.title = article.title;
    if (article.byline) result.byline = article.byline;
    if (article.excerpt) result.excerpt = article.excerpt;
  }
  if (truncated) result.truncated = true;
  return result;
}
