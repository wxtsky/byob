// wake-watch.ts imports cdp.js which calls chrome.tabs.onRemoved.addListener
// at module top-level. Bun test doesn't ship a chrome global, so install a
// minimal stub BEFORE the dynamic import below.
(globalThis as { chrome: unknown }).chrome = {
  tabs: { onRemoved: { addListener: () => {} } },
  debugger: {
    onDetach: { addListener: () => {} },
    onEvent: { addListener: () => {} },
  },
  alarms: {
    create: () => {},
    onAlarm: { addListener: () => {} },
  },
  idle: {
    setDetectionInterval: () => {},
    onStateChanged: { addListener: () => {} },
  },
};

import { test, expect } from 'bun:test';
const { __test } = await import('./wake-watch.js');

test('alarm-gap > 90s indicates wake', () => {
  const prev = 1_000_000;
  const now = prev + 91_000;
  expect(__test.evaluateAlarmGap(prev, now)).toBe(true);
});

test('alarm-gap = 60s does not indicate wake', () => {
  const prev = 1_000_000;
  const now = prev + 60_000;
  expect(__test.evaluateAlarmGap(prev, now)).toBe(false);
});

const T = 1_000_000;

test('idle → active after an alarm gap indicates wake', () => {
  expect(__test.evaluateIdleTransition('idle', 'active', T, T + 91_000)).toBe(true);
});

test('locked → active after an alarm gap indicates wake', () => {
  expect(__test.evaluateIdleTransition('locked', 'active', T, T + 91_000)).toBe(true);
});

test('idle → active with alarms still ticking is just the user coming back', () => {
  expect(__test.evaluateIdleTransition('idle', 'active', T, T + 30_000)).toBe(false);
  expect(__test.evaluateIdleTransition('locked', 'active', T, T + 60_000)).toBe(false);
});

test('active → idle transition does NOT indicate wake', () => {
  expect(__test.evaluateIdleTransition('active', 'idle', T, T + 91_000)).toBe(false);
});

test('locked → idle transition does NOT indicate wake', () => {
  expect(__test.evaluateIdleTransition('locked', 'idle', T, T + 91_000)).toBe(false);
});
