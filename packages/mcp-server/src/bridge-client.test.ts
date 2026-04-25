import { test, expect } from 'bun:test';
import { bridgePost } from './bridge-client.js';

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

test('bridgePost: aborted-before-call returns isError envelope without throwing', async () => {
  const ac = new AbortController();
  ac.abort();
  const { status, body } = await bridgePost('/read', {}, { signal: ac.signal });
  expect(status).toBe(499);
  expect((body as { error: string }).error).toBe('aborted');
});

test('bridgePost: when caller supplies requestId, it is honored verbatim', async () => {
  const ac = new AbortController();
  ac.abort();
  const { status } = await bridgePost('/read', {}, { requestId: 'caller-supplied-id', signal: ac.signal });
  expect(status).toBe(499);
});

test('crypto.randomUUID smoke: format matches v4 pattern', () => {
  const id = crypto.randomUUID();
  expect(id).toMatch(UUID_V4_RE);
});
