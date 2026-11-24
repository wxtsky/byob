import { describe, expect, test } from 'bun:test';
import { inCodeMode, outputMode } from './mode.js';
import { toolProfile } from './tools/profile.js';

describe('Code Mode detection', () => {
  test('Claude Code\'s switch turns on JSON output and every tool', () => {
    const env = { CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: '1' };
    expect(inCodeMode(env)).toBe(true);
    expect(outputMode(env)).toBe('json');
    expect(toolProfile(env)).toBe('full');
  });

  test('off, empty, 0 or false mean an ordinary client', () => {
    for (const v of [undefined, '', '0', 'false', 'FALSE']) {
      const env = { CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: v };
      expect(inCodeMode(env)).toBe(false);
      expect(outputMode(env)).toBe('text');
      expect(toolProfile(env)).toBe('core');
    }
  });

  test('BYOB_OUTPUT and BYOB_TOOLS override the detection', () => {
    expect(outputMode({ CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: '1', BYOB_OUTPUT: 'text' })).toBe('text');
    expect(outputMode({ BYOB_OUTPUT: 'json' })).toBe('json');
    expect(toolProfile({ CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: '1', BYOB_TOOLS: 'core' })).toBe('core');
    expect(toolProfile({ BYOB_TOOLS: 'full' })).toBe('full');
  });
});
