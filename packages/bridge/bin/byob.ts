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

program.parseAsync().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
