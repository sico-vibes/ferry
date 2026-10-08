import type { FerryClient } from '@ferry/client';
import type { Profile, SessionId } from '@ferry/shared';
import { formatLimits } from './format.js';

/* Quota and optimizer counts are intentionally interpolated into human-readable output. */
/* eslint-disable @typescript-eslint/restrict-template-expressions */

export interface SlashContext {
  client: FerryClient;
  sessionId: SessionId;
  cwd: string;
  onClear(): Promise<void>;
  onProfile(profile: Profile): void;
  onModel(ref: string): void;
  onCompact(summary: string): void;
  freeOnly?: boolean;
  onFreeOnly?(value: boolean): void;
}

export interface ParsedSlashCommand {
  name: string;
  args: string[];
}

export const SLASH_COMMANDS = [
  { name: '/model', usage: '[number|ref]', description: 'Choose a verified model or Gateway key' },
  { name: '/profile', usage: '[name]', description: 'Choose a routing profile' },
  { name: '/effort', description: 'Choose supported reasoning effort' },
  { name: '/sessions', description: 'Search project chats and Recents, then resume' },
  { name: '/project', description: 'Switch project or choose No project' },
  { name: '/settings', description: 'Change saved Ferry settings' },
  { name: '/new', description: 'Start a chat and choose its project' },
  { name: '/clear', description: 'Start a fresh chat in the same project' },
  { name: '/compact', description: 'Summarize model context through the engine' },
  { name: '/free', description: 'Toggle the free-only model filter' },
  { name: '/status', description: 'Show engine, providers, and cloud status' },
  { name: '/plan', description: 'Show the current task plan' },
  { name: '/diff', description: 'Show changes since the latest checkpoint' },
  { name: '/undo', description: 'Restore the latest checkpoint' },
  { name: '/delegate', usage: '<lane> <brief>', description: 'Start a delegation run' },
  { name: '/quota', description: 'Show provider quota windows' },
  { name: '/optimize', usage: 'on|off|stats', description: 'Configure optimizers or show savings' },
  { name: '/skills', description: 'List configured skills' },
  { name: '/mcp', description: 'List MCP servers and tools' },
  { name: '/login', usage: '<email>', description: 'Sign in to Ferry Cloud' },
  { name: '/logout', description: 'Sign out of Ferry Cloud' },
  { name: '/help', description: 'Show this command list' },
  { name: '/exit', description: 'Exit Ferry' },
] as const;

export function parseSlashCommand(command: string): ParsedSlashCommand {
  const [name = '', ...args] = command.trim().split(/\s+/);
  return { name: name.toLowerCase(), args };
}

export async function executeSlashCommand(context: SlashContext, command: string): Promise<string> {
  const { name, args: words } = parseSlashCommand(command);
  const { client, sessionId } = context;
  if (name === '/help')
    return SLASH_COMMANDS.map(
      (row) => `${row.name}${'usage' in row ? ` ${row.usage}` : ''} · ${row.description}`,
    ).join('\n');
  if (name === '/free') {
    const freeOnly = !(context.freeOnly ?? false);
    context.onFreeOnly?.(freeOnly);
    return `Free-only model listing ${freeOnly ? 'on' : 'off'}.`;
  }
  if (name === '/model') {
    const providers = await client.providers.list();
    const connected = new Set(
      providers.filter((row) => row.keyStatus === 'valid' && row.enabled).map((row) => row.id),
    );
    const models = (await client.models.list()).filter((row) => connected.has(row.providerId));
    const visible = models.filter((row) => !(context.freeOnly ?? false) || row.free);
    const value = words.join(' ');
    if (!value)
      return [
        '0. Auto',
        '1. No profile',
        ...visible.map((row, index) => `${index + 2}. ${row.ref}${row.free ? ' · free' : ''}`),
      ].join('\n');
    if (value.toLowerCase() === 'auto' || value === '0') {
      await client.models.select(sessionId, 'auto');
      context.onModel('auto');
      return 'Model set to Auto.';
    }
    const numeric = Number(value);
    if (value.toLowerCase() === 'no profile' || numeric === 1) {
      const profile = (await client.profiles.list()).find((row) => row.name === 'No profile');
      if (!profile) return 'No profile option is unavailable.';
      await client.profiles.activate(profile.id, sessionId);
      context.onProfile(profile);
      return 'Profile set to No profile.';
    }
    const selected =
      Number.isInteger(numeric) && numeric > 1
        ? visible[numeric - 2]
        : visible.find((row) => row.ref === value);
    if (!selected) return `Model not found in the current listing: ${value}`;
    await client.models.select(sessionId, selected.ref);
    context.onModel(selected.ref);
    return `Model set to ${selected.ref}`;
  }
  if (name === '/status') {
    const [info, providers, cloud] = await Promise.all([
      client.system.info(),
      client.providers.list(),
      client.cloud.status(),
    ]);
    return `Engine: ${info.mock ? 'mock' : 'real'}\nKeys: ${providers.filter((row) => row.keyStatus === 'valid' && row.enabled).length} connected providers\nCloud: ${cloud.auth.signedIn ? (cloud.auth.email ?? 'signed in') : 'signed out'}`;
  }
  if (name === '/profile') {
    const profiles = await client.profiles.list();
    if (!words.length) {
      const settings = await client.settings.get();
      return `Profiles:\n${profiles.map((row) => `${row.name}${row.id === settings.activeProfileId ? ' · active' : ''}`).join('\n')}`;
    }
    const profile = profiles.find(
      (row) => row.name.toLowerCase() === words.join(' ').toLowerCase(),
    );
    if (!profile)
      return `Profile not found. Available: ${profiles.map((row) => row.name).join(', ')}`;
    await client.profiles.activate(profile.id, sessionId);
    context.onProfile(profile);
    return `Profile set to ${profile.name}`;
  }
  if (name === '/plan') {
    const { taskRecord } = await client.sessions.get(sessionId);
    return taskRecord.plan.length
      ? taskRecord.plan
          .map(
            (item) =>
              `${item.status === 'done' ? '✓' : item.status === 'doing' ? '›' : '○'} ${item.text}`,
          )
          .join('\n')
      : 'No plan yet.';
  }
  if (name === '/diff') {
    const [checkpoint] = [...(await client.checkpoints.list(sessionId))].reverse();
    const { taskRecord } = await client.sessions.get(sessionId);
    const files = taskRecord.touchedFiles;
    if (!checkpoint)
      return files.length
        ? files.map((file) => `${file.path} · ${file.purpose}`).join('\n')
        : 'No checkpoint or file changes.';
    return `Since “${checkpoint.label}” · ${Math.max(0, files.length - checkpoint.fileCount)} changed files\n${
      files
        .slice(checkpoint.fileCount)
        .map((file) => `${file.path} · ${file.purpose}`)
        .join('\n') || 'No file changes.'
    }`;
  }
  if (name === '/undo') {
    const [checkpoint] = [...(await client.checkpoints.list(sessionId))].reverse();
    if (!checkpoint) return 'No checkpoint to restore.';
    await client.checkpoints.restore(checkpoint.id);
    return `Restored checkpoint: ${checkpoint.label}`;
  }
  if (name === '/delegate') {
    const lane = words[0];
    const brief = words.slice(1).join(' ');
    if (!lane || !brief) return 'Usage: /delegate <lane> <brief>';
    const run = await client.delegation.start({ sessionId, lane, brief });
    return `Delegation ${run.id} · ${run.lane} · ${run.status}`;
  }
  if (name === '/quota') {
    return formatLimits(await client.quota.limits());
  }
  if (name === '/optimize') {
    const mode = words[0];
    if (mode === 'stats' || !mode) {
      const stats = await client.optimizer.stats();
      return `Saved ${stats.today.savedTokens} tokens (${stats.today.percent}%)\n${stats.byOptimizer.map((row) => `${row.name}: ${row.savedTokens} tokens · ${row.enabled ? 'on' : 'off'}`).join('\n')}`;
    }
    if (mode !== 'on' && mode !== 'off') return 'Usage: /optimize on|off|stats';
    const settings = await client.settings.get();
    const enabled = mode === 'on';
    await client.settings.update({
      optimizers: {
        ...settings.optimizers,
        toolOutputFilters: enabled,
        recoveryHandles: enabled,
        contextHygiene: enabled,
        rtk: enabled,
        terse: enabled ? 'lite' : 'off',
      },
    });
    return `Optimizers ${mode}`;
  }
  if (name === '/skills') {
    const skills = await client.skills.list();
    return (
      skills
        .map((skill) => `${skill.enabled ? '●' : '○'} ${skill.name} · ${skill.description}`)
        .join('\n') || 'No skills configured.'
    );
  }
  if (name === '/mcp') {
    const servers = await client.mcp.list();
    return (
      servers
        .map((server) => `${server.name} · ${server.status} · ${server.toolCount} tools`)
        .join('\n') || 'No MCP servers configured.'
    );
  }
  if (name === '/compact') {
    await client.sessions.compact(sessionId);
    return 'Context summary requested through the engine. The full transcript remains available.';
  }
  if (name === '/clear') {
    await context.onClear();
    return 'Started a fresh chat.';
  }
  if (name === '/new') {
    await context.onClear();
    return 'Started a fresh chat.';
  }
  if (name === '/logout') {
    await client.cloud.signOut();
    return 'Signed out of Ferry Cloud.';
  }
  return `Unknown command ${name}. Use /help.`;
}
/* eslint-enable @typescript-eslint/restrict-template-expressions */
