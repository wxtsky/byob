/**
 * HTTP routes between mcp-server (client) and bridge (server) over the
 * unix-domain socket. Single source of truth — bridge-client.ts uses these
 * paths verbatim; bridge ipc-server matches POST tools by stripping the
 * leading slash and looking up `tools[stripped]`. Adding a new tool? Add a
 * row here, register a handler under the matching key in bridge/main.ts,
 * and append an entry in mcp-server/src/tools/all.ts.
 */
export const Routes = {
  /** Generic: body `{ command, params }` → extension handler `command`. */
  call: '/call',
  /** download_images needs the bridge's loopback upload server. */
  downloadImages: '/download-images',
} as const;

/** GET-only routes — no body required. */
export const GetRoutes = {
  listTabs: '/tabs',
  status: '/status',
} as const;

/** Strip the leading slash for use as a key in bridge `tools` map. */
export function routeKey(p: string): string {
  return p.startsWith('/') ? p.slice(1) : p;
}

export type RoutePathName = keyof typeof Routes;
export type RoutePath = (typeof Routes)[RoutePathName];
