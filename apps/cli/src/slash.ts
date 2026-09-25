import type { FerryClient } from '@ferry/client';
import type { ModelRef, Profile, SessionId } from '@ferry/shared';
import { formatCapacity } from './format.js';

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
}
export async function executeSlashCommand(context: SlashContext, command: string): Promise<string> {
  const [name, ...words] = command.trim().split(/\s+/);
  const { client, sessionId } = context;
  if (name === '/help')
    return '/profile <name> /model <id|auto> /plan /diff /undo /delegate <lane> <brief> /quota /optimize on|off|stats /skills /mcp /compact /clear';
  if (name === '/profile') {
    const profiles = await client.profiles.list();
    const profile = profiles.find(
      (row) => row.name.toLowerCase() === words.join(' ').toLowerCase(),
    );
    if (!profile)
      return `Profile not found. Available: ${profiles.map((row) => row.name).join(', ')}`;
    await client.profiles.activate(profile.id, sessionId);
    context.onProfile(profile);
    return `Profile set to ${profile.name}`;
  }
  if (name === '/model') {
    const value = words.join(' ');
    if (!value) return 'Usage: /model <id|auto>';
    const ref = value === 'auto' ? 'auto' : (value as ModelRef);
    await client.models.select(sessionId, ref);
    context.onModel(value);
    return `Model set to ${value}`;
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
    const capacity = await client.quota.capacity();
    const providers = await client.providers.list();
    return `${formatCapacity(capacity)}\n${capacity.perProvider.map((row) => `${providers.find((provider) => provider.id === row.providerId)?.name ?? row.providerId}: ${row.stepsLeft ?? 'unlimited'} steps`).join('\n')}`;
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
    const { messages } = await client.sessions.get(sessionId);
    const count = messages.reduce((total, message) => total + message.parts.length, 0);
    const summary = `Transcript compacted locally · ${count} message parts; session history is still stored by the client.`;
    context.onCompact(summary);
    return summary;
  }
  if (name === '/clear') {
    await context.onClear();
    return 'Started a fresh chat.';
  }
  return `Unknown command ${name ?? ''}. Use /help.`;
}
/* eslint-enable @typescript-eslint/restrict-template-expressions */
