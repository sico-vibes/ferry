import { describe, expect, it, vi } from 'vitest';
import { createMockFerryClient } from '@ferry/client';
import { executeSlashCommand, parseSlashCommand } from '../src/slash.js';

describe('interactive slash commands', () => {
  it('connect, gateway and doctor use shared Core domains without leaking secrets', async () => {
    const client = createMockFerryClient();
    const session = (await client.sessions.list())[0];
    if (!session) throw new Error('Missing fixture');
    const ctx = context(client, session.id);
    const key = await client.gateway.createKey({ name: 'Smoke client', profile: 'auto-free' });
    expect(await executeSlashCommand(ctx, '/connect')).toContain('openrouter');
    expect(await executeSlashCommand(ctx, '/gateway start')).toContain('started');
    const status = await executeSlashCommand(ctx, '/gateway status');
    expect(status).toContain('Smoke client');
    expect(status).toContain('free only');
    expect(status).not.toContain(key.secret);
    expect(await executeSlashCommand(ctx, '/gateway requests')).toContain('No Gateway requests');
    expect(await executeSlashCommand(ctx, '/doctor')).toContain('No credentials');
    expect(await executeSlashCommand(ctx, '/gateway stop')).toContain('stopped');
  });
  it('parses slash command names case-insensitively and preserves arguments', () => {
    expect(parseSlashCommand('  /MODEL openai/gpt-4  ')).toEqual({
      name: '/model',
      args: ['openai/gpt-4'],
    });
  });

  it('/profile updates the active session profile', async () => {
    const client = createMockFerryClient();
    const sessions = await client.sessions.list();
    const session = sessions[0];
    const profile = (await client.profiles.list())[1];
    if (!session || !profile) throw new Error('mock fixtures missing');
    const result = await executeSlashCommand(
      context(client, session.id),
      `/profile ${profile.name}`,
    );
    expect(result).toContain(profile.name);
    expect((await client.sessions.get(session.id)).session.profileId).toBe(profile.id);
  });

  it('/quota renders inline capacity', async () => {
    const client = createMockFerryClient();
    const session = (await client.sessions.list())[0];
    if (!session) throw new Error('mock session missing');
    const output = await executeSlashCommand(context(client, session.id), '/quota');
    expect(output).toContain('requests');
    expect(output).not.toContain('steps');
    expect(output).toContain('Gemini');
  });

  it('/model 1 selects the built-in No profile option', async () => {
    const client = createMockFerryClient();
    const session = (await client.sessions.list())[0];
    const noProfile = (await client.profiles.list()).find((row) => row.name === 'No profile');
    if (!session || !noProfile) throw new Error('mock No profile fixture missing');
    const result = await executeSlashCommand(context(client, session.id), '/model 1');
    expect(result).toContain('No profile');
    expect((await client.sessions.get(session.id)).session.profileId).toBe(noProfile.id);
  });

  it('/clear starts a new chat using its callback', async () => {
    const client = createMockFerryClient();
    const session = (await client.sessions.list())[0];
    if (!session) throw new Error('mock session missing');
    const clear = vi.fn(() => Promise.resolve());
    await executeSlashCommand(context(client, session.id, clear), '/clear');
    expect(clear).toHaveBeenCalledOnce();
  });

  it('/undo restores the most recent checkpoint', async () => {
    const client = createMockFerryClient();
    const sessions = await client.sessions.list();
    const session = sessions[2];
    if (!session) throw new Error('checkpoint fixture session missing');
    const restore = vi.spyOn(client.checkpoints, 'restore');
    const output = await executeSlashCommand(context(client, session.id), '/undo');
    expect(output).toContain('Restored checkpoint');
    expect(restore).toHaveBeenCalledOnce();
  });
});

function context(
  client: ReturnType<typeof createMockFerryClient>,
  sessionId: import('@ferry/shared').SessionId,
  onClear = () => Promise.resolve(),
) {
  return {
    client,
    sessionId,
    cwd: process.cwd(),
    onClear,
    onProfile: () => undefined,
    onModel: () => undefined,
    onCompact: () => undefined,
  };
}
