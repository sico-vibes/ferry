import { expect, it } from 'vitest';
import { cliCommandName } from '../src/cli-connection/command-name.js';

it('resolves installed commands separately from connection IDs, including Claude Code', () => {
  expect(cliCommandName('codex-cli')).toBe('codex');
  expect(cliCommandName('claude-code-cli')).toBe('claude');
  expect(cliCommandName('opencode-cli')).toBe('opencode');
});
