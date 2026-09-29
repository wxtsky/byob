/**
 * Tool definitions are re-sent to the model on every turn. The SDK's
 * zod → JSON Schema conversion adds boilerplate the model gains nothing from:
 * a `$schema` URL and `additionalProperties: false` on every object (~80
 * characters per tool). Unknown arguments are dropped by zod on parse
 * anyway, so strip both from tools/list responses on their way out.
 */
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

export function stripSchemaNoise(schema: unknown): void {
  if (!schema || typeof schema !== 'object') return;
  if (Array.isArray(schema)) {
    for (const v of schema) stripSchemaNoise(v);
    return;
  }
  const o = schema as Record<string, unknown>;
  delete o.$schema;
  if (o.additionalProperties === false) delete o.additionalProperties;
  for (const v of Object.values(o)) stripSchemaNoise(v);
}

export function leanToolList<T extends Transport>(transport: T): T {
  const send = transport.send.bind(transport);
  transport.send = (message, options) => {
    const result = (message as { result?: { tools?: Array<{ inputSchema?: unknown }> } }).result;
    if (result && Array.isArray(result.tools)) for (const t of result.tools) stripSchemaNoise(t.inputSchema);
    return send(message, options);
  };
  return transport;
}
