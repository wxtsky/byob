/**
 * Who reads tool results first.
 *
 * Normally the model does, so results are rendered as compact text
 * (format.ts). In Claude Code's Code Mode the model calls tools from
 * JavaScript and a script gets every result before the model sees anything:
 * there a result whose text is JSON arrives as a parsed object, and a JSON
 * error as the thrown error's `detail`. So in Code Mode byob answers in JSON.
 *
 * BYOB_OUTPUT=json|text overrides the detection.
 */
export type OutputMode = 'text' | 'json';

/** MCP servers inherit Claude Code's environment, Code Mode switch included. */
export function inCodeMode(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.CLAUDE_CODE_EXPERIMENTAL_CODE_MODE;
  return v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false';
}

export function outputMode(env: NodeJS.ProcessEnv = process.env): OutputMode {
  if (env.BYOB_OUTPUT === 'json' || env.BYOB_OUTPUT === 'text') return env.BYOB_OUTPUT;
  return inCodeMode(env) ? 'json' : 'text';
}
