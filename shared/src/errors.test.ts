import { test, expect } from 'bun:test';
import { ErrorCode } from './errors.js';

test('ABORTED maps to "aborted"', () => {
  expect(ErrorCode.ABORTED).toBe('aborted');
});

test('ABORTED_DUE_TO_WAKE maps to "aborted_due_to_wake"', () => {
  expect(ErrorCode.ABORTED_DUE_TO_WAKE).toBe('aborted_due_to_wake');
});

test('all error codes are unique', () => {
  const values = Object.values(ErrorCode);
  expect(new Set(values).size).toBe(values.length);
});
