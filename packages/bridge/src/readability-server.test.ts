import { test, expect } from 'bun:test';
import {
  htmlToMarkdown,
  ReadabilityNoArticleError,
} from './readability-server.js';

const ARTICLE_HTML = `
<!doctype html>
<html><head><title>Hello world</title></head>
<body>
  <nav><a href="/">home</a> <a href="/about">about</a></nav>
  <article>
    <h1>Hello world</h1>
    <p class="byline">By Jane Doe</p>
    <p>This is a paragraph with <strong>bold</strong> text and <a href="https://example.com">a link</a>.</p>
    <p>Another paragraph long enough to keep Readability happy. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Phasellus euismod, libero a luctus.</p>
    <pre><code>const x = 1;</code></pre>
    <p><img src="https://example.com/image.png" alt="example image"></p>
  </article>
  <footer>copyright</footer>
</body></html>`;

test('htmlToMarkdown extracts title + body, default opts', () => {
  const r = htmlToMarkdown(ARTICLE_HTML, {
    includeMetadata: true,
    includeImages: true,
    preserveCode: true,
  });
  expect(r.title).toBe('Hello world');
  // Readability strips the leading <h1> when it duplicates the page title, so
  // we don't assert it shows up in the body — the title field already covers
  // that. We instead check article body text we know stays.
  expect(r.markdown).toContain('Lorem ipsum');
  expect(r.markdown).toContain('**bold**');
  expect(r.markdown).toContain('```');
  expect(r.markdown).toContain('![example image]');
  expect(r.lengthChars).toBe(r.markdown.length);
});

test('htmlToMarkdown drops images when includeImages=false', () => {
  const r = htmlToMarkdown(ARTICLE_HTML, {
    includeMetadata: true,
    includeImages: false,
    preserveCode: true,
  });
  expect(r.markdown).not.toContain('![');
  expect(r.markdown).not.toContain('example.com/image.png');
});

test('htmlToMarkdown emits indented code blocks when preserveCode=false', () => {
  const r = htmlToMarkdown(ARTICLE_HTML, {
    includeMetadata: false,
    includeImages: true,
    preserveCode: false,
  });
  expect(r.markdown).not.toContain('```');
  // Indented code blocks render as 4-space-prefixed lines.
  expect(r.markdown).toMatch(/    const x = 1;/);
  expect(r.title).toBeUndefined();
});

test('htmlToMarkdown truncates and marks truncated', () => {
  const r = htmlToMarkdown(ARTICLE_HTML, {
    includeMetadata: false,
    includeImages: true,
    preserveCode: true,
    maxLength: 50,
  });
  expect(r.truncated).toBe(true);
  expect(r.markdown.endsWith('\n\n[truncated]\n')).toBe(true);
  expect(r.lengthChars).toBe(r.markdown.length);
});

test('htmlToMarkdown throws ReadabilityNoArticleError on empty body', () => {
  const html = '<!doctype html><html><body></body></html>';
  try {
    htmlToMarkdown(html, {
      includeMetadata: true,
      includeImages: true,
      preserveCode: true,
    });
    throw new Error('expected throw');
  } catch (e) {
    expect(e).toBeInstanceOf(ReadabilityNoArticleError);
    expect((e as ReadabilityNoArticleError).htmlLength).toBe(html.length);
  }
});
