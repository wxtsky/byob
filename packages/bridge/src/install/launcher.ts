/**
 * The Native Messaging launcher: the tiny script Chrome executes to start
 * the bridge. Two flavours:
 *
 *  - bundle (default install): `node <BYOB_DIR>/bridge/byob-bridge.mjs`, a
 *    single-file build copied out of the repo, so pulling, switching branches
 *    or deleting the checkout never changes the bridge Chrome is running.
 *  - source (`install --dev`): `tsx packages/bridge/bin/byob-bridge.ts`, so a
 *    contributor's edits take effect on the next bridge start.
 *
 * Pure string building / parsing — install, doctor and the e2e harness share it.
 */
export type LauncherMode = 'bundle' | 'source';

export interface LauncherSpec {
  win: boolean;
  /** Directory prepended to PATH so node (and tsx's `#!/usr/bin/env node`) resolve. */
  nodeDir: string;
  /** Program + arguments; Chrome's own arguments are appended. */
  argv: string[];
  /** Extra environment (the e2e harness sets BYOB_HOME). */
  env?: Record<string, string>;
}

const MARKER = 'byob bridge launcher';

export function launcherBody(spec: LauncherSpec, mode: LauncherMode): string {
  const env = Object.entries(spec.env ?? {});
  if (spec.win) {
    // .cmd batch file. %* forwards the arguments Chrome passes to the host;
    // stdio handles are inherited by the child.
    return [
      '@echo off',
      `rem ${MARKER} (${mode})`,
      ...env.map(([k, v]) => `set "${k}=${v}"`),
      `set "PATH=${spec.nodeDir};%PATH%"`,
      `${spec.argv.map((a) => `"${a}"`).join(' ')} %*`,
    ].join('\r\n') + '\r\n';
  }
  return [
    '#!/bin/sh',
    `# ${MARKER} (${mode})`,
    ...env.map(([k, v]) => `export ${k}="${v}"`),
    `export PATH="${spec.nodeDir}:$PATH"`,
    `exec ${spec.argv.map((a) => `"${a}"`).join(' ')} "$@"`,
    '',
  ].join('\n');
}

export interface LauncherInfo {
  mode: LauncherMode | 'unknown';
  /** Program + script the launcher runs (quoted paths on its last command line). */
  argv: string[];
}

/** What an existing launcher runs — for `byob doctor`. Also reads pre-0.6 launchers. */
export function parseLauncher(body: string): LauncherInfo {
  const lines = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const cmd = [...lines].reverse().find((l) => /^exec\s|^"/.test(l)) ?? '';
  const argv = [...cmd.matchAll(/"([^"]+)"/g)].map((m) => m[1]!).filter((a) => a !== '$@');
  const script = argv[argv.length - 1] ?? '';
  const mode: LauncherInfo['mode'] = /\.m?js$/i.test(script) ? 'bundle' : /\.ts$/i.test(script) ? 'source' : 'unknown';
  return { mode, argv };
}
