import React from 'react';
import { render } from 'ink';
import type { FerryClient } from '@ferry/client';
import { gradient, muted } from './colors.js';
import { Chat } from './tui.js';

export async function interactive(client: FerryClient, cwd: string): Promise<void> {
  const workspace = await client.workspaces.open(cwd);
  const profiles = await client.profiles.list();
  const settings = await client.settings.get();
  const profile = profiles.find((item) => item.id === settings.activeProfileId) ?? profiles[0];
  if (!profile) throw new Error('No profiles configured. Run ferry init.');
  process.stdout.write(
    `${gradient('Ferry — your coding companion')}\n${muted('Use /help for commands · Ctrl+C twice exits')}\n`,
  );
  const app = render(<Chat client={client} workspace={workspace} profile={profile} />);
  await app.waitUntilExit();
}
