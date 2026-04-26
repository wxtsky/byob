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

import {
  InterceptStartInput,
  InterceptStopInput,
  DragInput,
  EmulateDeviceInput,
} from './schemas.js';

// ---------- v0.3 Batch 3 ----------

test('InterceptStartInput requires url-or-tabId and at least one rule', () => {
  expect(() => InterceptStartInput.parse({})).toThrow();
  expect(() =>
    InterceptStartInput.parse({ url: 'https://example.com', rules: [] }),
  ).toThrow();
  const v = InterceptStartInput.parse({
    url: 'https://example.com',
    rules: [{ urlPattern: 'https://example.com/*', action: 'block' }],
  });
  expect(v.rules.length).toBe(1);
});

test('InterceptStartInput rule requires urlPattern XOR urlRegex', () => {
  // both
  expect(() =>
    InterceptStartInput.parse({
      tabId: 1,
      rules: [
        { urlPattern: 'https://*', urlRegex: '.*', action: 'block' },
      ],
    }),
  ).toThrow();
  // neither
  expect(() =>
    InterceptStartInput.parse({
      tabId: 1,
      rules: [{ action: 'block' }],
    }),
  ).toThrow();
});

test('InterceptStartInput rule rejects mismatched action sub-object', () => {
  expect(() =>
    InterceptStartInput.parse({
      tabId: 1,
      rules: [
        // action='block' but fulfill sub-object provided
        { urlPattern: '*', action: 'block', fulfill: { status: 200 } },
      ],
    }),
  ).toThrow();
});

test('InterceptStartInput modifyResponse: bodyReplace XOR bodyRegex', () => {
  expect(() =>
    InterceptStartInput.parse({
      tabId: 1,
      rules: [
        {
          urlPattern: '*',
          action: 'modifyResponse',
          modifyResponse: {
            bodyReplace: 'foo',
            bodyRegex: { pattern: 'a', replacement: 'b' },
          },
        },
      ],
    }),
  ).toThrow();
});

test('InterceptStartInput fulfill: body XOR bodyBase64', () => {
  expect(() =>
    InterceptStartInput.parse({
      tabId: 1,
      rules: [{ urlPattern: '*', action: 'fulfill', fulfill: { body: 'a', bodyBase64: 'b' } }],
    }),
  ).toThrow();
  // positive: either alone is valid
  const v = InterceptStartInput.parse({
    tabId: 1,
    rules: [{ urlPattern: '*', action: 'fulfill', fulfill: { body: 'hello' } }],
  });
  expect(v.rules[0].fulfill?.body).toBe('hello');
});

test('InterceptStopInput requires interceptId', () => {
  expect(() => InterceptStopInput.parse({})).toThrow();
  expect(() => InterceptStopInput.parse({ interceptId: '' })).toThrow();
  const v = InterceptStopInput.parse({ interceptId: 'abc' });
  expect(v.interceptId).toBe('abc');
});

test('DragInput accepts selector OR {x,y} for from/to', () => {
  const a = DragInput.parse({ tabId: 1, from: '#a', to: '#b' });
  expect(a.from).toBe('#a');
  const b = DragInput.parse({ tabId: 1, from: { x: 10, y: 20 }, to: { x: 100, y: 200 } });
  expect(b.from).toEqual({ x: 10, y: 20 });
  const c = DragInput.parse({ tabId: 1, from: '#a', to: { x: 100, y: 200 } });
  expect(c.to).toEqual({ x: 100, y: 200 });
});

test('DragInput defaults: button=left, durationMs=500, steps=30', () => {
  const v = DragInput.parse({ tabId: 1, from: '#a', to: '#b' });
  expect(v.button).toBe('left');
  expect(v.durationMs).toBe(500);
  expect(v.steps).toBe(30);
});

test('DragInput rejects steps=1 or durationMs<50', () => {
  expect(() =>
    DragInput.parse({ tabId: 1, from: '#a', to: '#b', steps: 1 }),
  ).toThrow();
  expect(() =>
    DragInput.parse({ tabId: 1, from: '#a', to: '#b', durationMs: 49 }),
  ).toThrow();
});

test('DragInput rejects invalid from/to values', () => {
  expect(() =>
    DragInput.parse({ tabId: 1, from: 42, to: '#b' }),
  ).toThrow();
  expect(() =>
    DragInput.parse({ tabId: 1, from: '', to: '#b' }),
  ).toThrow();
  expect(() =>
    DragInput.parse({ tabId: 1, from: { x: 1 }, to: '#b' }),
  ).toThrow();
});

test('EmulateDeviceInput requires exactly one of preset or custom', () => {
  expect(() => EmulateDeviceInput.parse({ tabId: 1 })).toThrow();
  expect(() =>
    EmulateDeviceInput.parse({
      tabId: 1,
      preset: 'iphone-17',
      custom: { width: 320, height: 568, deviceScaleFactor: 2, mobile: true },
    }),
  ).toThrow();
  const a = EmulateDeviceInput.parse({ tabId: 1, preset: 'desktop' });
  expect(a.preset).toBe('desktop');
  const b = EmulateDeviceInput.parse({
    tabId: 1,
    custom: { width: 320, height: 568, deviceScaleFactor: 2, mobile: true },
  });
  expect(b.custom?.width).toBe(320);
});

test('EmulateDeviceInput rejects unknown preset', () => {
  expect(() =>
    EmulateDeviceInput.parse({ tabId: 1, preset: 'iphone-99' }),
  ).toThrow();
});
