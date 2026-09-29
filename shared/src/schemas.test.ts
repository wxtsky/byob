import { test, expect } from 'bun:test';
import { GetPerformanceInput } from './schemas.js';
import * as Tools from './tools.js';

test('v0.5 tool inputs carry agent-friendly defaults', () => {
  expect(Tools.TypeInput.parse({ text: 'x' }).clear).toBe(true);
  expect(Tools.NavigateInput.parse({ url: 'https://a.b' }).action).toBe('goto');
  expect(Tools.NavigateInput.parse({}).waitUntil).toBe('load');
  expect(Tools.FindInput.parse({ role: 'button' })).toMatchObject({ limit: 10, nth: 0, exact: false });
  expect(Tools.TabsInput.parse({}).action).toBe('list');
  expect(Tools.ReadInput.parse({}).format).toBe('text');
  expect(Tools.PressKeyInput.parse({ key: 'Enter' }).repeat).toBe(1);
});

test('v0.5 tool inputs reject malformed arguments', () => {
  expect(() => Tools.BatchInput.parse({ steps: [] })).toThrow();
  expect(() => Tools.SelectInput.parse({ values: [] })).toThrow();
  expect(() => Tools.UploadFileInput.parse({ paths: [] })).toThrow();
  expect(() => Tools.ClickInput.parse({ button: 'side' })).toThrow();
  expect(() => Tools.NetworkInput.parse({})).toThrow();
});

test('cookie items for storage set are validated separately', () => {
  expect(Tools.CookieSetItem.parse({ name: 'a', value: 'b', sameSite: 'lax' }).name).toBe('a');
  expect(() => Tools.CookieSetItem.parse({ name: 'a', value: 'b', sameSite: 'Lax' })).toThrow();
});

test('GetPerformanceInput defaults waitMs=3000, max 30000', () => {
  const v = GetPerformanceInput.parse({ url: 'https://example.com' });
  expect(v.waitMs).toBe(3000);
  expect(() =>
    GetPerformanceInput.parse({ url: 'https://example.com', waitMs: 30_001 }),
  ).toThrow();
});

import {
  InterceptStartInput,
  InterceptStopInput,
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
