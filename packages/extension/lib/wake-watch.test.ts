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

test('idle → active transition indicates wake', () => {
  expect(__test.evaluateIdleTransition('idle', 'active')).toBe(true);
});

test('locked → active transition indicates wake', () => {
  expect(__test.evaluateIdleTransition('locked', 'active')).toBe(true);
});

test('active → idle transition does NOT indicate wake', () => {
  expect(__test.evaluateIdleTransition('active', 'idle')).toBe(false);
});

test('locked → idle transition does NOT indicate wake', () => {
  expect(__test.evaluateIdleTransition('locked', 'idle')).toBe(false);
});
