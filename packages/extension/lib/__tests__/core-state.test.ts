import { beforeEach, describe, expect, it } from 'bun:test';
import {
  _resetContextRegistryForTests,
  contextFor,
  forgetContextById,
  forgetSessionContexts,
  forgetTabContexts,
  recordContext,
} from '../frame-resolver.js';
import { forgetTabConsole, noteAttached, onConsoleEvent, readConsole } from '../console-buffer.js';

describe('execution-context registry', () => {
  beforeEach(() => _resetContextRegistryForTests());

  it('only forgets a context of the same tab and session', () => {
    recordContext(1, 'A-main', 3);
    recordContext(2, 'B-main', 3);
    recordContext(2, 'B-oopif', 3, 'S1');
    forgetContextById(1, 3);
    expect(contextFor('A-main')).toBeUndefined();
    expect(contextFor('B-main')).toBe(3);
    expect(contextFor('B-oopif')).toBe(3);
    forgetContextById(2, 3, 'S1');
    expect(contextFor('B-main')).toBe(3);
    expect(contextFor('B-oopif')).toBeUndefined();
  });

  it('clears one session, or a whole tab', () => {
    recordContext(1, 'main', 1);
    recordContext(1, 'child', 2, 'S1');
    recordContext(2, 'other', 1);
    forgetSessionContexts(1, 'S1');
    expect(contextFor('child')).toBeUndefined();
    expect(contextFor('main')).toBe(1);
    forgetTabContexts(1);
    expect(contextFor('main')).toBeUndefined();
    expect(contextFor('other')).toBe(1);
  });
});

describe('console buffer', () => {
  const TAB = 99;
  beforeEach(() => forgetTabConsole(TAB));
  const log = (ts: number, text: string): void =>
    onConsoleEvent(TAB, 'Runtime.consoleAPICalled', {
      type: 'log',
      timestamp: ts,
      args: [{ type: 'string', value: text }],
      stackTrace: { callFrames: [{ url: 'https://a.test/app.js', lineNumber: 0, columnNumber: 0 }] },
    });

  it('drops the history Runtime.enable replays on re-attach', () => {
    const t = Date.now() - 10_000;
    log(t, 'hello');
    noteAttached(TAB);
    log(t, 'hello'); // replayed
    expect(readConsole(TAB).entries.map((e) => e.text)).toEqual(['hello']);
  });

  it('keeps identical lines logged after the attach', () => {
    noteAttached(TAB);
    const t = Date.now() + 1000;
    log(t, 'tick');
    log(t, 'tick');
    expect(readConsole(TAB).entries).toHaveLength(2);
  });

  it('reads from the start when the cursor predates a restart', () => {
    noteAttached(TAB);
    log(Date.now() + 1000, 'after restart');
    const r = readConsole(TAB, { since: 1e9 });
    expect(r.reset).toBe(true);
    expect(r.entries.map((e) => e.text)).toEqual(['after restart']);
  });
});
