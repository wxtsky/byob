/**
 * Host policy management for the `byob policy` CLI. Not exposed as an MCP
 * tool: an agent must never be able to widen its own access.
 */
import { z } from 'zod';
import { FLAG_KEYS, HOST_POLICY_KEYS, coerceDomainList } from '../url-guard.js';

const PolicyInput = z.object({
  allowedDomains: z.array(z.string()).optional(),
  deniedDomains: z.array(z.string()).optional(),
  allowFile: z.boolean().optional(),
  allowAuthDomains: z.boolean().optional(),
});

export async function handlePolicy(raw: unknown): Promise<unknown> {
  const p = PolicyInput.parse(raw ?? {});
  const set: Record<string, unknown> = {};
  if (p.allowedDomains) set.BYOB_ALLOWED_DOMAINS = coerceDomainList(p.allowedDomains);
  if (p.deniedDomains) set.BYOB_DENIED_DOMAINS = coerceDomainList(p.deniedDomains);
  if (p.allowFile !== undefined) set.BYOB_ALLOW_FILE = p.allowFile;
  if (p.allowAuthDomains !== undefined) set.BYOB_ALLOW_AUTH_DOMAINS = p.allowAuthDomains;
  if (Object.keys(set).length) await chrome.storage.local.set(set);
  const cur = await chrome.storage.local.get([...FLAG_KEYS, ...HOST_POLICY_KEYS] as unknown as string[]);
  return {
    allowedDomains: coerceDomainList(cur.BYOB_ALLOWED_DOMAINS),
    deniedDomains: coerceDomainList(cur.BYOB_DENIED_DOMAINS),
    allowFile: !!cur.BYOB_ALLOW_FILE,
    allowAuthDomains: !!cur.BYOB_ALLOW_AUTH_DOMAINS,
    changed: Object.keys(set),
  };
}
