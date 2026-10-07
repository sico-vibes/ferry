import React from 'react';
import { render } from 'ink';
import { createInterface } from 'node:readline/promises';
import type { FerryClient } from '@ferry/client';
import { gradient, muted } from './colors.js';
import { Chat } from './tui.js';
import { selectTerminalStreams } from './terminal.js';

export async function interactive(
  client: FerryClient,
  cwd: string,
  engine: 'local' | 'mock' = 'local',
): Promise<number> {
  const terminal = selectTerminalStreams();
  if (!terminal) {
    process.stderr.write(
      'ferry needs an interactive terminal. Use `ferry run "<prompt>"` for scripts.\n',
    );
    return 2;
  }
  const workspace = await client.workspaces.open(cwd);
  const profiles = await client.profiles.list();
  const settings = await client.settings.get();
  const profile = profiles.find((item) => item.id === settings.activeProfileId) ?? profiles[0];
  if (!workspace.trusted) {
    if (workspace.riskyRoot)
      terminal.stdout.write(`Warning: ${workspace.path} is a risky workspace root.\n`);
    const prompt = createInterface({ input: terminal.stdin, output: terminal.stdout });
    let answer: string;
    try {
      answer = await prompt.question(`Trust ${workspace.path}? (y/N) `);
    } finally {
      prompt.close();
    }
    if (!['y', 'yes'].includes(answer.trim().toLowerCase())) {
      terminal.stdout.write('Workspace not trusted; no message was sent.\n');
      terminal.dispose();
      return 0;
    }
    await client.workspaces.trust(workspace.id);
  }
  terminal.stdout.write(
    `${gradient('Ferry — your coding companion')}\n${muted('Use /help for commands · Ctrl+C twice exits')}\n`,
  );
  try {
    const app = render(
      <Chat client={client} workspace={workspace} profile={profile} engine={engine} />,
      // selectTerminalStreams already proved this is a console. Without this, Ink stops drawing
      // whenever CI is set (GitHub runners, some shells) and the chat never appears.
      { stdin: terminal.stdin, stdout: terminal.stdout, interactive: true },
    );
    await app.waitUntilExit();
    return 0;
  } finally {
    terminal.dispose();
  }
}
