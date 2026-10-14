import type { CliConnectionKind } from '@ferry/shared';

const commands = {
  'codex-cli': 'codex',
  'claude-code-cli': 'claude',
  'opencode-cli': 'opencode',
} as const;

/** Provider IDs are stable labels; executable names are the installed clients' actual commands. */
export function cliCommandName(kind: CliConnectionKind) {
  return commands[kind];
}
