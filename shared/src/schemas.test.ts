import { test, expect } from 'bun:test';
import {
  GetConsoleLogsInput,
  GetConsoleLogsInputRaw,
  ReadMarkdownInput,
  ExtractTableInput,
} from './schemas.js';

test('GetConsoleLogsInput requires url or tabId', () => {
  expect(() => GetConsoleLogsInput.parse({})).toThrow();
  expect(GetConsoleLogsInput.parse({ url: 'https://example.com' }).level).toEqual(['warn', 'error']);
  expect(GetConsoleLogsInput.parse({ tabId: 1 }).flushDelayMs).toBe(200);
});

test('GetConsoleLogsInput.level rejects exception (input-only filter)', () => {
  expect(() =>
    GetConsoleLogsInputRaw.parse({ url: 'https://example.com', level: ['exception'] }),
  ).toThrow();
});

test('GetConsoleLogsInput.flushDelayMs is capped at 5000', () => {
  expect(() => GetConsoleLogsInput.parse({ url: 'https://example.com', flushDelayMs: 5001 })).toThrow();
});

test('ReadMarkdownInput defaults', () => {
  const v = ReadMarkdownInput.parse({ url: 'https://example.com' });
  expect(v.includeImages).toBe(true);
  expect(v.preserveCode).toBe(true);
  expect(v.maxLength).toBeUndefined();
});

test('ExtractTableInput defaults selector to table and format to rows', () => {
  const v = ExtractTableInput.parse({ tabId: 7 });
  expect(v.selector).toBe('table');
  expect(v.format).toBe('rows');
});

test('ExtractTableInput rejects empty body', () => {
  expect(() => ExtractTableInput.parse({})).toThrow();
});

import {
  ScrollInput,
  PressKeyInput,
  SelectInput,
  CloseTabInput,
  GoBackInput,
  HoverInput,
  GetHtmlInput,
} from './schemas.js';

test('ScrollInput requires exactly one of {to, selector, y}', () => {
  expect(() => ScrollInput.parse({ url: 'https://example.com' })).toThrow();
  expect(() => ScrollInput.parse({ url: 'https://example.com', to: 'top', y: 100 })).toThrow();
  expect(ScrollInput.parse({ url: 'https://example.com', to: 'top' }).behavior).toBe('auto');
  expect(ScrollInput.parse({ tabId: 1, y: 500 }).y).toBe(500);
});

test('PressKeyInput requires url or tabId and a non-empty key', () => {
  expect(() => PressKeyInput.parse({ url: 'https://example.com' })).toThrow();
  expect(() => PressKeyInput.parse({ key: 'Enter' })).toThrow();
  expect(PressKeyInput.parse({ tabId: 7, key: 'Enter' }).modifiers).toEqual([]);
});

test('SelectInput requires exactly one of {value, label, index}', () => {
  expect(() => SelectInput.parse({ tabId: 1, selector: 'select' })).toThrow();
  expect(() =>
    SelectInput.parse({ tabId: 1, selector: 'select', value: 'a', label: 'b' }),
  ).toThrow();
  expect(SelectInput.parse({ tabId: 1, selector: 'select', value: 'a' }).value).toBe('a');
});

test('CloseTabInput requires tabId', () => {
  expect(() => CloseTabInput.parse({})).toThrow();
  expect(CloseTabInput.parse({ tabId: 7 }).tabId).toBe(7);
});

test('GoBackInput defaults timeoutSec to 30', () => {
  expect(GoBackInput.parse({ tabId: 7 }).timeoutSec).toBe(30);
});

test('HoverInput requires url or tabId and a selector', () => {
  expect(() => HoverInput.parse({ url: 'https://example.com' })).toThrow();
  expect(HoverInput.parse({ tabId: 1, selector: '.foo' }).selector).toBe('.foo');
});

test('GetHtmlInput defaults selector to html, outerHtml to true, maxBytes to 256KB', () => {
  const v = GetHtmlInput.parse({ tabId: 1 });
  expect(v.selector).toBe('html');
  expect(v.outerHtml).toBe(true);
  expect(v.maxBytes).toBe(262144);
});

test('GetHtmlInput rejects maxBytes > 8MB', () => {
  expect(() => GetHtmlInput.parse({ tabId: 1, maxBytes: 9 * 1024 * 1024 })).toThrow();
});

import {
  SetCookiesInput,
  PrintPdfInput,
  GetStorageInput,
  GetPerformanceInput,
  UploadFileInput,
} from './schemas.js';

// ---------- v0.3 Batch 2 ----------

test('SetCookiesInput requires url, name, value', () => {
  expect(() => SetCookiesInput.parse({})).toThrow();
  expect(() => SetCookiesInput.parse({ url: 'https://example.com' })).toThrow();
  expect(() => SetCookiesInput.parse({ url: 'https://example.com', name: 'x' })).toThrow();
  const v = SetCookiesInput.parse({ url: 'https://example.com', name: 'x', value: '1' });
  expect(v.name).toBe('x');
});

test('SetCookiesInput sameSite is lowercase', () => {
  expect(() =>
    SetCookiesInput.parse({ url: 'https://example.com', name: 'x', value: '1', sameSite: 'Lax' }),
  ).toThrow();
  const v = SetCookiesInput.parse({
    url: 'https://example.com',
    name: 'x',
    value: '1',
    sameSite: 'lax',
  });
  expect(v.sameSite).toBe('lax');
});

test('PrintPdfInput requires url or tabId, defaults paperFormat=A4', () => {
  expect(() => PrintPdfInput.parse({})).toThrow();
  const v = PrintPdfInput.parse({ url: 'https://example.com' });
  expect(v.paperFormat).toBe('A4');
  expect(v.printBackground).toBe(true);
  expect(v.margin).toBe(0.4);
  expect(v.scale).toBe(1);
});

test('PrintPdfInput rejects invalid scale and margin', () => {
  expect(() =>
    PrintPdfInput.parse({ url: 'https://example.com', scale: 3 }),
  ).toThrow();
  expect(() =>
    PrintPdfInput.parse({ url: 'https://example.com', margin: -0.1 }),
  ).toThrow();
});

test('GetStorageInput defaults kind=both, maxBytes=1MB', () => {
  const v = GetStorageInput.parse({ url: 'https://example.com' });
  expect(v.kind).toBe('both');
  expect(v.maxBytes).toBe(1024 * 1024);
});

test('GetStorageInput rejects unknown kind', () => {
  expect(() =>
    GetStorageInput.parse({ url: 'https://example.com', kind: 'cookies' }),
  ).toThrow();
});

test('GetPerformanceInput defaults waitMs=3000, max 30000', () => {
  const v = GetPerformanceInput.parse({ url: 'https://example.com' });
  expect(v.waitMs).toBe(3000);
  expect(() =>
    GetPerformanceInput.parse({ url: 'https://example.com', waitMs: 30_001 }),
  ).toThrow();
});

test('UploadFileInput requires selector and at least one path', () => {
  expect(() =>
    UploadFileInput.parse({ url: 'https://example.com', selector: '#f' }),
  ).toThrow();
  expect(() =>
    UploadFileInput.parse({ url: 'https://example.com', selector: '#f', paths: [] }),
  ).toThrow();
  const v = UploadFileInput.parse({
    url: 'https://example.com',
    selector: '#f',
    paths: ['/tmp/a.txt'],
  });
  expect(v.paths).toEqual(['/tmp/a.txt']);
});
