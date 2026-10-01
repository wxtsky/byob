import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveBridge } from './resolve-bridge.js';
import { ensureBridge } from './bridge-client.js';
import { asErrorEnvelope } from './error-mapper.js';
import { getWorkingTab, noteTab, resetState } from './state.js';

// scripts/test-preload.ts points BYOB_HOME at a throwaway directory.
const home = process.env.BYOB_HOME!;
const registry = path.join(home, 'bridges.json');
const launcher = path.join(home, process.platform === 'win32' ? 'bridge-host.cmd' : 'bridge-host.sh');

afterEach(() => {
  fs.rmSync(registry, { force: true });
  fs.rmSync(launcher, { force: true });
  resetState();
});

const entry = (startedAt: number) => ({ deviceId: 'dev-1', pid: process.pid, socket: path.join(home, 'x.sock'), startedAt });

describe('resolveBridge diagnosis', () => {
  test('no launcher: byob is not set up', () => {
    expect(() => resolveBridge()).toThrow("byob isn't set up");
  });

  test('set up, but no live bridge: the browser side is missing', () => {
    fs.writeFileSync(launcher, '#!/bin/sh\n');
    fs.writeFileSync(registry, JSON.stringify([{ ...entry(1), pid: 2 ** 22 + 12345 }]));
    let caught: { code?: string; message?: string; hint?: string } = {};
    try {
      resolveBridge();
    } catch (e) {
      caught = e as typeof caught;
    }
    expect(caught.code).toBe('bridge_not_running');
    expect(caught.message).toContain("Chrome isn't running, or the byob extension is disabled");
    expect(caught.hint).toContain('chrome://extensions');
  });
});

describe('bridge identity', () => {
  test('a restarted bridge drops the remembered working tab', () => {
    fs.writeFileSync(registry, JSON.stringify([entry(1000)]));
    ensureBridge();
    noteTab(42, { opened: true });
    ensureBridge();
    expect(getWorkingTab()).toBe(42);
    fs.writeFileSync(registry, JSON.stringify([entry(2000)]));
    ensureBridge();
    expect(getWorkingTab()).toBeUndefined();
  });
});

test('"No handler for" means the extension predates the MCP server', () => {
  const env = asErrorEnvelope({ error: 'unknown', message: 'No handler for record' }, 'x');
  expect(env.hint).toContain('reload the byob extension');
});
