import type { FerryClient } from '@ferry/client';
import type { Profile, SessionId } from '@ferry/shared';
import { formatLimits } from './format.js';
import { collectDiagnostics } from '@ferry/client';
import { OPTIMIZATION_PRESETS, ProviderIdSchema, optimizationPreset } from '@ferry/shared';
import { configureTool } from './tools.js';

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
  { name: '/speed', usage: '[standard|fast]', description: 'Choose native CLI standard or fast' },
  { name: '/sessions', description: 'Search project chats and Recents, then resume' },
  { name: '/project', description: 'Switch project or choose No project' },
  { name: '/settings', description: 'Change saved Ferry settings' },
  { name: '/connect', description: 'Connect an API, account or local provider' },
  {
    name: '/gateway',
    usage: '[status|start|stop|requests|routing|configure <tool>]',
    description: 'Manage the shared local Gateway',
  },
  { name: '/doctor', description: 'Read sanitized Core and provider diagnostics' },
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
  if (name === '/doctor') {
    const report = await collectDiagnostics(client);
    return [
      `Ferry ${report.version} · ${report.platform}${report.mock ? ' · fixture engine' : ''}`,
      `Gateway: ${report.gateway.running ? 'running' : 'stopped'} · port ${report.gateway.port}`,
      ...report.providers
        .filter((row) => row.enabled)
        .map(
          (row) =>
            `${row.id}: ${row.keyStatus} · ${row.health} · ${row.modelCount} discovered models${row.discoveryErrorClass ? ` · discovery ${row.discoveryErrorClass}` : ''}`,
        ),
      'Read-only diagnostics. No credentials, paths, prompts or responses included.',
    ].join('\n');
  }
  if (name === '/connect') {
    const id = words[0];
    if (!id)
      return (await client.providers.list())
        .map((row) => `${row.id}: ${row.keyStatus} · ${row.enabled ? 'enabled' : 'disabled'}`)
        .join('\n');
    if (words[1] === 'endpoint') {
      const settings = await client.settings.get();
      const provider = (await client.providers.list()).find((row) => row.id === id);
      if (provider?.kind !== 'api') return 'Choose an API or local provider from /connect.';
      const url = words[2];
      if (!url) return 'Usage: /connect <provider> endpoint <base-url>';
      await client.settings.update({
        providerEndpoints: { ...settings.providerEndpoints, [id]: url },
      });
      return 'Endpoint saved. Check the connection again; previous model evidence was cleared.';
    }
    if (words[1] !== 'check')
      return 'Use /connect to open the connection picker; /connect <provider> check checks saved access; /connect <provider> endpoint <base-url> changes its endpoint.';
    const result = await client.providers.probe(ProviderIdSchema.parse(id));
    return `${id}: ${result.ok ? 'reachable' : 'needs attention'} · ${result.message}`;
  }
  if (name === '/gateway') {
    const action = words[0] ?? 'status';
    if (action === 'start') {
      await client.gateway.start();
      return 'Gateway started.';
    }
    if (action === 'stop') {
      await client.gateway.stop();
      return 'Gateway stopped.';
    }
    if (action === 'requests') {
      const page = await client.gateway.history({ range: '24h', limit: 10 });
      return (
        page.records
          .map(
            (row) =>
              `${row.requestedModel} → ${row.servedModel ?? row.modelRef ?? 'unavailable'} · ${row.outcome ?? row.status}`,
          )
          .join('\n') || 'No Gateway requests in the last 24 hours.'
      );
    }
    if (action === 'routing') return JSON.stringify(await client.gateway.routing(), null, 2);
    if (action === 'configure') {
      const tool = words[1];
      if (!['codex', 'opencode', 'claude'].includes(tool ?? ''))
        return 'Usage: /gateway configure codex|opencode|claude [--apply]';
      const keys = (await client.gateway.listKeys()).filter((key) => !key.revokedAt);
      await configureTool(client, tool as 'codex' | 'opencode' | 'claude', {
        keyId: keys[0]?.id ?? 'new',
        model: 'ferry/auto',
        preview: !words.includes('--apply'),
      });
      return words.includes('--apply')
        ? 'Client configured; an existing configuration was backed up.'
        : 'Masked configuration preview printed. Add --apply to write it with a backup.';
    }
    if (action !== 'status')
      return 'Usage: /gateway status|start|stop|requests|routing|configure <tool>';
    const [gateway, keys] = await Promise.all([
      client.gateway.settings(),
      client.gateway.listKeys(),
    ]);
    const status = gateway.status;
    return [
      `Gateway: ${status.running ? 'running' : 'stopped'} · ${status.url ?? 'no endpoint'} · requested route ferry/auto`,
      ...keys
        .filter((key) => !key.revokedAt)
        .map(
          (key) =>
            `${key.name}: ${key.profile} · ${key.paidBackup ? `paid backup up to $${key.budgetUsd ?? 0}/month` : 'free only'}`,
        ),
      'Use /gateway start, requests, routing or configure <tool>.',
    ].join('\n');
  }
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
      return stats.demo
        ? 'No optimizer measurements yet. Savings appear only after recorded traffic.'
        : `Saved ${stats.today.savedTokens} tokens (${stats.today.percent}%)\n${stats.byOptimizer.map((row) => `${row.name}: ${row.savedTokens} tokens · ${row.enabled ? 'on' : 'off'}`).join('\n')}`;
    }
    if (!['on', 'off', 'fidelity', 'savings', 'advanced'].includes(mode))
      return 'Usage: /optimize fidelity|savings|advanced|stats';
    const settings = await client.settings.get();
    if (mode === 'advanced')
      return `Effective global preset: ${optimizationPreset(settings.optimizers)}. Use /settings to edit individual switches; profiles override global defaults.`;
    const preset = mode === 'on' || mode === 'savings' ? 'savings' : 'fidelity';
    await client.settings.update({
      optimizers: OPTIMIZATION_PRESETS[preset],
    });
    return `Optimizers ${mode} · profiles retain their explicit overrides; Gateway/API clients preserve fidelity.`;
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
