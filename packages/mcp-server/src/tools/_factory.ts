import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZodObject, ZodRawShape, ZodTypeAny, z } from 'zod';
import { bridgePost, bridgeGet } from '../bridge-client.js';
import { asErrorEnvelope, toMcpError } from '../error-mapper.js';

/**
 * Single shape every MCP tool registration uses. Replaces ~30 lines of
 * boilerplate per tool with one declarative entry. The boilerplate that
 * used to be:
 *
 *   server.registerTool(name, { title, description, inputSchema: Input.shape },
 *     async (args, extra) => {
 *       const { status, body } = await bridgePost(route, args, { signal: extra.signal });
 *       if (status >= 400) return toMcpError(asErrorEnvelope(body, ...));
 *       const parsed = Output.safeParse(body);
 *       if (!parsed.success) return toMcpError({ error:'unknown', message: parsed.error.message });
 *       return { content: [{ type:'text', text: JSON.stringify(parsed.data) }] };
 *     });
 *
 * is now `defineTool({ name, route, input, output, ... })`.
 */
export interface ToolDef<
  I extends ZodObject<ZodRawShape> = ZodObject<ZodRawShape>,
  O extends ZodTypeAny = ZodTypeAny,
> {
  name: string;
  title: string;
  description: string;
  /** HTTP path on the bridge. Use Routes.* / GetRoutes.* from @byob/shared. */
  route: string;
  /** Defaults to POST. Use 'GET' for body-less tools (currently just list_tabs). */
  method?: 'POST' | 'GET';
  /** Zod object whose .shape becomes the MCP inputSchema. */
  input: I;
  /** Zod schema used to validate the bridge response before forwarding. */
  output: O;
  /**
   * Optional: derive `_meta` keys to attach to the MCP response from the
   * parsed output payload (e.g. browser_eval surfaces `fallbackUsed`).
   */
  meta?: (parsed: z.infer<O>) => Record<string, unknown>;
  /** When false the tool is skipped (e.g. browser_eval gated by env var). */
  enabled?: () => boolean;
}

export function defineTool<
  I extends ZodObject<ZodRawShape>,
  O extends ZodTypeAny,
>(def: ToolDef<I, O>): (server: McpServer) => void {
  return (server: McpServer): void => {
    if (def.enabled && !def.enabled()) return;
    const isGet = def.method === 'GET';
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: def.input.shape,
      },
      async (args, extra) => {
        const { status, body } = isGet
          ? await bridgeGet(def.route, { signal: extra.signal })
          : await bridgePost(def.route, args, { signal: extra.signal });
        if (status >= 400) {
          return toMcpError(asErrorEnvelope(body, `bridge ${status}`));
        }
        const parsed = def.output.safeParse(body);
        if (!parsed.success) {
          return toMcpError({ error: 'unknown', message: parsed.error.message });
        }
        const text = JSON.stringify(parsed.data);
        if (def.meta) {
          return {
            content: [{ type: 'text', text }],
            _meta: def.meta(parsed.data),
          };
        }
        return { content: [{ type: 'text', text }] };
      },
    );
  };
}
