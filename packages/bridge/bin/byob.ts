#!/usr/bin/env -S npx tsx
import { Command } from 'commander';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  install,
  readPublicKeyFromExtensionConfig,
  bridgeEntryAbsForDev,
  tsxBinAbs,
} from '../src/install.js';

const program = new Command();
program.name('byob').description('byob management CLI').version('0.1.0');

program
  .command('install')
  .description('install Native Messaging manifest for the byob extension')
  .option('--dev', 'launcher runs source via tsx (no build needed)')
  .action((opts: { dev?: boolean }) => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(here, '../../..');
    const publicKeyB64 = readPublicKeyFromExtensionConfig(repoRoot);
    const bridgeEntryAbs = bridgeEntryAbsForDev(repoRoot);
    install({
      dev: !!opts.dev,
      publicKeyB64,
      bridgeEntryAbs,
      tsxBinAbs: opts.dev ? tsxBinAbs(repoRoot) : undefined,
    });
  });

program
  .command('doctor')
  .description('diagnose connectivity')
  .action(async () => {
    const { doctor } = await import('../src/doctor.js');
    await doctor();
  });

program
  .command('bridges')
  .description('list live bridge processes')
  .action(async () => {
    const { listAliveBridges } = await import('../src/bridge-registry.js');
    const alive = listAliveBridges();
    if (alive.length === 0) {
      console.log('No live bridges.');
      return;
    }
    for (const b of alive) {
      const upS = Math.round((Date.now() - b.startedAt) / 1000);
      console.log(`${b.deviceId}  pid ${b.pid}  ${b.socket}  uptime ${upS}s`);
    }
  });

program
  .command('logs')
  .description('tail ~/.byob/bridge.log')
  .option('-f, --follow', 'follow new log lines')
  .action(async (opts: { follow?: boolean }) => {
    const { tailLog } = await import('../src/logs.js');
    await tailLog({ follow: !!opts.follow });
  });

program
  .command('uninstall')
  .description('remove launcher + Native Messaging manifests')
  .action(async () => {
    const { uninstall } = await import('../src/uninstall.js');
    uninstall();
  });

program.parseAsync().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
