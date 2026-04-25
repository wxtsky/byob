#!/usr/bin/env -S npx tsx
import { Command } from 'commander';

const program = new Command();
program.name('byob').description('byob management CLI').version('0.1.0');

program.command('install').description('install Native Messaging manifest').action(() => {
  console.error('install: not implemented yet (Phase 1)');
});
program.command('doctor').description('diagnose connectivity').action(() => {
  console.error('doctor: not implemented yet (Phase 1)');
});

program.parseAsync().catch((err) => {
  console.error(err);
  process.exit(1);
});
