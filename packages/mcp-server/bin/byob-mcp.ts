#!/usr/bin/env -S npx tsx
import { runMcpServer } from '../src/server.js';
runMcpServer().catch((e) => {
  console.error('[byob-mcp] fatal:', e);
  process.exit(1);
});
