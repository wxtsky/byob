// All MCP tool definitions live in `./all.ts` as a single declarative table
// driven by `defineTool()` from `./_factory.ts`. Adding / changing a tool
// happens in one place; the bridge route table (`shared/src/routes.ts`)
// keeps the names in sync at compile time.
export { registerAllTools } from './all.js';
