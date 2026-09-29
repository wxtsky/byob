// Ad-hoc driver: BYOB_E2E_SKIP_BUILD=1 bun e2e/explore.ts
import { startE2E } from './harness';

const e = await startE2E();
const show = async (name: string, args: Record<string, unknown> = {}) => {
  const t0 = Date.now();
  const r = await e.call(name, args);
  console.log(`\n=== ${name} ${JSON.stringify(args)} (${Date.now() - t0}ms)${r.isError ? ' ERROR' : ''}`);
  console.log(r.text.slice(0, 3000));
  if (r.images.length) console.log(`[${r.images.length} image(s), ${r.images[0]!.data.length} b64 chars]`);
  return r;
};
try {
  const steps = JSON.parse(process.argv[2] ?? '[]') as Array<[string, Record<string, unknown>]>;
  for (const [name, args] of steps) {
    const a = JSON.parse(JSON.stringify(args).replaceAll('ORIGIN', e.origin).replaceAll('CROSS', e.crossOrigin));
    await show(name, a);
  }
} finally {
  await e.close();
}
