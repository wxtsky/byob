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
