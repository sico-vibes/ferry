import { defineCommand, runMain } from 'citty';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { createClientAsync } from './client.js';
import { good, muted, warn } from './colors.js';
import { collectDoctor } from './doctor.js';
import type { FerryClient } from '@ferry/client';

/* Event handlers intentionally return promises to the event emitter; the parser narrows argv flags. */
/* eslint-disable @typescript-eslint/no-confusing-void-expression, @typescript-eslint/no-unnecessary-condition, @typescript-eslint/return-await, @typescript-eslint/consistent-type-definitions, @typescript-eslint/restrict-template-expressions */

export async function runPrompt(
  client: FerryClient,
  prompt: string,
  json: boolean,
  profileName?: string,
  cwd = process.cwd(),
  options: {
    permission?: 'ask' | 'auto_edit' | 'full_auto';
    maxSteps?: number;
    verbose?: boolean;
  } = {},
): Promise<number> {
  const settings = await client.settings.get();
  if (options.permission) await client.settings.update({ permissionMode: options.permission });
  const workspace = await client.workspaces.open(cwd);
  const profiles = await client.profiles.list();
  const profile = profiles.find((item) => item.name === profileName) ?? profiles[0];
  const session = await client.sessions.create({
    workspaceId: workspace.id,
    ...(profile ? { profileId: profile.id } : {}),
    title: prompt.slice(0, 60),
  });
  let approvalNeeded = false;
  let failed = false;
  let stepLimitExceeded = false;
  let stepCount = 0;
  const seenParts = new Set<string>();
  let finishRun!: () => void;
  const done = new Promise<void>((resolve) => {
    finishRun = resolve;
  });
  const disposers = [
    client.on('session.delta', (event) => {
      if (event.sessionId !== session.id) return;
      emit(json, { type: 'session.delta', ...event }, event.textDelta);
    }),
    client.on('session.part', (event) => {
      if (event.sessionId !== session.id) return;
      if (event.part.type === 'approval_request' && event.part.state === 'pending') {
        const mode = options.permission ?? settings.permissionMode;
        if (mode === 'full_auto' || (mode === 'auto_edit' && event.part.kind === 'edit')) {
          void client.approvals.respond(
            session.id,
            event.part.id,
            mode === 'full_auto' ? 'allow_always' : 'allow_once',
          );
        } else if (process.stdin.isTTY && process.stdout.isTTY) {
          void askApproval(event.part.summary).then((decision) => {
            if (!decision || decision === 'deny') approvalNeeded = true;
            return client.approvals.respond(session.id, event.part.id, decision ?? 'deny');
          });
        } else {
          approvalNeeded = true;
          void client.sessions.cancel(session.id);
        }
      }
      if (!seenParts.has(event.part.id)) {
        seenParts.add(event.part.id);
        stepCount += 1;
        if (options.maxSteps !== undefined && stepCount > options.maxSteps && !stepLimitExceeded) {
          stepLimitExceeded = true;
          void client.sessions.cancel(session.id);
        }
      }
      if (event.part.type === 'error') {
        failed = true;
        if (options.verbose && event.part.details)
          process.stderr.write(`Routing exclusions: ${formatRoutingDetails(event.part.details)}\n`);
      }
      emit(json, { type: 'session.part', ...event }, summarize(event.part));
    }),
    client.on('session.message', (event) => {
      if (event.sessionId === session.id) emit(json, { type: 'session.message', ...event });
    }),
    client.on('task.updated', (event) => emit(json, { type: 'task.updated', payload: event })),
    client.on('quota.updated', (event) => emit(json, { type: 'quota.updated', payload: event })),
    client.on('provider.updated', (event) =>
      emit(json, { type: 'provider.updated', payload: event }),
    ),
    client.on('delegation.updated', (event) =>
      emit(json, { type: 'delegation.updated', payload: event }),
    ),
    client.on('toast', (event) => emit(json, { type: 'toast', payload: event })),
  ];
  disposers.push(
    client.on('session.updated', (value) => {
      if (value.id === session.id && ['idle', 'error'].includes(value.status)) finishRun();
    }),
  );
  try {
    await client.sessions.send(session.id, { text: prompt });
    await done;
  } finally {
    disposers.forEach((off) => off());
    if (options.permission)
      await client.settings.update({ permissionMode: settings.permissionMode });
  }
  if (stepLimitExceeded) {
    process.stderr.write(`Maximum step count (${options.maxSteps}) exceeded.\n`);
    return 1;
  }
  if (approvalNeeded) return 3;
  return failed ? 1 : 0;
}

function emit(json: boolean, event: Record<string, unknown>, human?: string) {
  if (json) process.stdout.write(`${JSON.stringify(event)}\n`);
  else if (human) process.stdout.write(`${human}\n`);
}
async function askApproval(
  summary: string,
): Promise<'allow_once' | 'allow_always' | 'deny' | null> {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await terminal.question(`Approval needed: ${summary} [y/n/a] `))
      .trim()
      .toLowerCase();
    return answer === 'y'
      ? 'allow_once'
      : answer === 'a'
        ? 'allow_always'
        : answer === 'n'
          ? 'deny'
          : null;
  } finally {
    terminal.close();
  }
}
function summarize(part: import('@ferry/shared').MessagePart): string | undefined {
  if (part.type === 'tool_call') return `${part.title}: ${part.status}`;
  if (part.type === 'approval_request') return `Approval required: ${part.summary}`;
  if (part.type === 'handoff_marker') return `Handoff ${part.from} → ${part.to}`;
  if (part.type === 'checkpoint') return `Checkpoint: ${part.label}`;
  if (part.type === 'error') return `Error: ${part.message}`;
  return undefined;
}

function formatRoutingDetails(details: string): string {
  try {
    const parsed: unknown = JSON.parse(details);
    if (!Array.isArray(parsed)) return 'Routing details unavailable';
    const entries: unknown[] = parsed;
    const rows = entries.flatMap((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
      const row = entry as Record<string, unknown>;
      if (typeof row.modelRef !== 'string' || !Array.isArray(row.reasons)) return [];
      const reasons = (row.reasons as unknown[]).filter(
        (reason): reason is string => typeof reason === 'string',
      );
      return [`${row.modelRef}: ${reasons.join(', ')}`];
    });
    const shown = rows.slice(0, 12);
    if (rows.length > shown.length)
      shown.push(`${String(rows.length - shown.length)} more excluded models`);
    return shown.join('; ');
  } catch {
    return 'Routing details unavailable';
  }
}

export async function runCli(argv = process.argv.slice(2)): Promise<number> {
  let json = argv.includes('--json') || argv.some((arg) => arg.startsWith('--json='));
  let verbose = argv.includes('--verbose');
  let client: (FerryClient & { dispose?: () => Promise<void> }) | undefined;
  try {
    const flags = readFlags(argv);
    json = flags.values.json === true;
    verbose = flags.values.verbose === true;
    validateFlags(flags.values);
    const command = flags.positionals[0];
    const dataDir = stringFlag(flags.values['data-dir']);
    const cwd = stringFlag(flags.values.cwd) ?? process.cwd();
    const engine = flags.values.engine ?? (command === 'oauth' ? 'local' : 'mock');
    if (engine !== 'mock' && engine !== 'local')
      throw new CliError(2, 'Invalid --engine. Use mock or local.');
    if (command === 'run') validateRunArguments(flags);
    if (command === 'resume' && !flags.positionals[1])
      throw new CliError(2, 'Usage: ferry resume <sessionId>');
    if (command && !CLI_COMMANDS.has(command)) throw new CliError(2, `Unknown command: ${command}`);
    if (
      command === 'oauth' &&
      flags.positionals[1] === 'login' &&
      flags.positionals[2] &&
      (!process.stdin.isTTY || !process.stdout.isTTY) &&
      flags.values['i-understand-the-risk'] !== true
    )
      throw new CliError(2, 'Non-interactive OAuth login requires --i-understand-the-risk.');
    client = await createClientAsync({
      engine,
      ...(dataDir ? { dataDir } : {}),
    });
    if (!command) {
      const { interactive } = await import('./interactive.js');
      await interactive(client, cwd);
      return 0;
    }
    if (command === 'run') {
      const prompt = flags.positionals.slice(1).join(' ');
      const code = await runPrompt(
        client,
        prompt,
        flags.values.json === true,
        stringFlag(flags.values.profile),
        cwd,
        {
          ...(typeof flags.values.permission === 'string' &&
          ['ask', 'auto_edit', 'full_auto'].includes(flags.values.permission)
            ? { permission: flags.values.permission as 'ask' | 'auto_edit' | 'full_auto' }
            : {}),
          ...(typeof flags.values['max-steps'] === 'string' &&
          Number.isFinite(Number(flags.values['max-steps']))
            ? { maxSteps: Number(flags.values['max-steps']) }
            : {}),
          ...(verbose ? { verbose: true } : {}),
        },
      );
      return code;
    }
    if (command === 'resume') return await resume(client, flags.positionals[1], json);
    if (command === 'serve') {
      writeResult(
        json,
        { message: 'engine transport coming in B0' },
        'engine transport coming in B0\n',
      );
      return 0;
    }
    if (command === 'quota')
      return flags.values.watch === true ? quotaWatch(client, json) : await quota(client, json);
    if (command === 'providers') return await providers(client, flags.positionals.slice(1), json);
    if (command === 'oauth') return await oauth(client, flags.positionals.slice(1), json);
    if (command === 'profiles') return await profiles(client, flags.positionals.slice(1), json);
    if (command === 'skills') return await skills(client, flags.positionals.slice(1), json);
    if (command === 'mcp') return await listDomain(client, 'mcp', json);
    if (command === 'lanes') return await lanes(client, flags.positionals.slice(1), json);
    if (command === 'optimize') {
      const stats = await client.optimizer.stats();
      writeResult(json, stats, JSON.stringify(stats, null, 2) + '\n');
      return 0;
    }
    if (command === 'doctor') return await doctor(dataDir, undefined, json);
    if (command === 'keys') return await keys(client, flags.positionals.slice(1), json);
    if (command === 'init') return await runInit(client, cwd, flags.values.yes === true, json);
    throw new CliError(2, `Unknown command: ${command}`);
  } catch (error) {
    const code = error instanceof CliError ? error.code : 1;
    const message = error instanceof Error ? error.message : String(error);
    if (json) process.stdout.write(`${JSON.stringify({ error: { code, message } })}\n`);
    else
      process.stderr.write(
        verbose && error instanceof Error && error.stack
          ? `ferry: ${message}\n${error.stack}\n`
          : `ferry: ${message}\n`,
      );
    return code;
  } finally {
    await client?.dispose?.();
  }
}

class CliError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

function writeResult(json: boolean, value: unknown, human: string): void {
  process.stdout.write(json ? `${JSON.stringify(value)}\n` : human);
}

export async function main(): Promise<void> {
  const command = defineCommand({
    meta: { name: 'ferry', version: '0.1.0', description: 'Ferry coding agent CLI' },
    run: async () => {
      process.exitCode = await runCli();
    },
  });
  await runMain(command);
}

type Flags = { positionals: string[]; values: Record<string, string | boolean> };
const CLI_COMMANDS = new Set([
  'run',
  'resume',
  'serve',
  'quota',
  'providers',
  'oauth',
  'profiles',
  'skills',
  'mcp',
  'lanes',
  'optimize',
  'doctor',
  'keys',
  'init',
]);
const VALUE_FLAGS = new Set([
  'cwd',
  'profile',
  'data-dir',
  'engine',
  'permission',
  'max-steps',
  'delegation',
  'model',
]);
function readFlags(argv: string[]): Flags {
  const positionals: string[] = [];
  const values: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token?.startsWith('--')) {
      if (token) positionals.push(token);
      continue;
    }
    const [rawKey, inline] = token.slice(2).split('=', 2);
    const key = rawKey ?? '';
    if (inline !== undefined) values[key] = inline;
    else if (argv[i + 1] && !argv[i + 1]?.startsWith('--')) values[key] = argv[++i] ?? '';
    else if (VALUE_FLAGS.has(key)) throw new CliError(2, `Missing value for --${key}`);
    else values[key] = true;
  }
  return { positionals, values };
}
function validateFlags(values: Record<string, string | boolean>): void {
  for (const key of VALUE_FLAGS) {
    const value = values[key];
    if (value === '') throw new CliError(2, `Missing value for --${key}`);
  }
}
function validateRunArguments(flags: Flags): void {
  if (!flags.positionals.slice(1).join(' ')) throw new CliError(2, 'Usage: ferry run <prompt>');
  const permission = flags.values.permission;
  if (typeof permission === 'string' && !['ask', 'auto_edit', 'full_auto'].includes(permission))
    throw new CliError(2, 'Invalid --permission. Use ask, auto_edit, or full_auto.');
  const maxSteps = flags.values['max-steps'];
  if (typeof maxSteps === 'string' && (!/^\d+$/.test(maxSteps) || Number(maxSteps) < 1))
    throw new CliError(2, 'Invalid --max-steps. Provide a positive integer.');
}
function stringFlag(value: string | boolean | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

async function quota(client: FerryClient, json: boolean) {
  const value = await client.quota.capacity();
  if (json) process.stdout.write(`${JSON.stringify(value)}\n`);
  else {
    const count = Math.round((value.percentRemaining / 100) * 9);
    process.stdout.write(
      `Capacity  ${value.stepsLeftToday} steps left  ${'▰'.repeat(count)}${'▱'.repeat(9 - count)} ${value.percentRemaining}%\n`,
    );
    for (const reset of value.nextResets)
      process.stdout.write(
        `  ${reset.providerId} · ${reset.label} · ${new Date(reset.at).toLocaleString()}\n`,
      );
  }
  return value.stepsLeftToday === 0 ? 4 : 0;
}
async function quotaWatch(client: FerryClient, json: boolean): Promise<number> {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) {
    if (json) {
      const snapshot = await client.quota.capacity();
      process.stdout.write(`${JSON.stringify({ type: 'quota.update', payload: snapshot })}\n`);
      return snapshot.stepsLeftToday === 0 ? 4 : 0;
    }
    return quota(client, false);
  }
  let snapshot = await client.quota.capacity();
  const redraw = () => {
    if (json) {
      process.stdout.write(`${JSON.stringify({ type: 'quota.update', payload: snapshot })}\n`);
      return;
    }
    process.stdout.write('\u001b[2J\u001b[H');
    const barCount = Math.round((snapshot.percentRemaining / 100) * 9);
    process.stdout.write(
      `Ferry quota · ${snapshot.stepsLeftToday} steps left · ${'▰'.repeat(barCount)}${'▱'.repeat(9 - barCount)} ${snapshot.percentRemaining}%\n`,
    );
    for (const reset of snapshot.nextResets) {
      const minutes = Math.max(0, Math.ceil((Date.parse(reset.at) - Date.now()) / 60_000));
      process.stdout.write(
        `  ${reset.providerId} · ${reset.label} · reset in ${Math.floor(minutes / 60)}h ${minutes % 60}m\n`,
      );
    }
    if (!json) process.stdout.write('\nPress q or Ctrl+C to exit.\n');
  };
  redraw();
  const off = client.on('quota.updated', (value) => {
    snapshot = value;
    redraw();
  });
  const timer = setInterval(redraw, 1000);
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const finish = () => {
      clearInterval(timer);
      off();
      stdin.setRawMode(false);
      stdin.off('data', onData);
      stdin.pause();
      resolve(0);
    };
    const onData = (data: Buffer) => {
      if (data.includes(3) || data.toString('utf8').toLowerCase().includes('q')) finish();
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}
async function providers(client: FerryClient, args: string[], json = false) {
  const [action, id] = args;
  const rows = await client.providers.list();
  if (action === 'test' && id) {
    const result = await client.providers.probe(id as import('@ferry/shared').ProviderId);
    writeResult(json, result, `${result.ok ? good('OK') : warn('CHECK')} ${result.message}\n`);
    return result.ok ? 0 : 1;
  }
  if ((action === 'enable' || action === 'disable') && id) {
    await client.providers.setEnabled(
      id as import('@ferry/shared').ProviderId,
      action === 'enable',
    );
    writeResult(json, { providerId: id, enabled: action === 'enable' }, '');
    return 0;
  }
  writeResult(
    json,
    rows,
    rows
      .map((p) => `${p.enabled ? good('●') : muted('○')} ${p.id} · ${p.name} · ${p.keyStatus}`)
      .join('\n') + '\n',
  );
  return 0;
}

async function oauth(client: FerryClient, args: string[], json = false): Promise<number> {
  const [action, id] = args;
  if (action === 'login' && id) {
    const provider = (await client.oauth.list()).find((item) => item.id === id);
    if (!provider) throw new CliError(2, `Unknown subscription OAuth provider: ${id}`);
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      // The risk flag above is the acknowledgement for headless invocations.
    } else {
      process.stderr.write(`Use your ${provider.name} subscription outside its official app?\n`);
      process.stderr.write(
        `Logging in uses an unofficial client. ${provider.name} may treat this as a terms violation and suspend or ban your account. Ferry cannot protect you. Use an API key or the provider's official CLI instead.\n`,
      );
      const terminal = createInterface({ input: process.stdin, output: process.stderr });
      let answer: string;
      try {
        answer = (await terminal.question('Continue? [y/N] ')).trim().toLowerCase();
      } finally {
        terminal.close();
      }
      if (answer !== 'y' && answer !== 'yes') return 2;
    }
    const off = client.on('oauth.progress', (event) => {
      if (event.id !== id || event.type === 'success' || event.type === 'error') return;
      const message =
        event.type === 'open_url'
          ? `Open ${event.url}${event.instructions ? `\n${event.instructions}` : ''}`
          : `Enter ${event.userCode} at ${event.verificationUri}`;
      if (json)
        process.stdout.write(`${JSON.stringify({ type: 'oauth.progress', payload: event })}\n`);
      else process.stderr.write(`${message}\n`);
    });
    try {
      await client.oauth.login(provider.id);
      writeResult(json, { providerId: id, connected: true }, `Logged in to ${provider.name}.\n`);
      return 0;
    } finally {
      off();
    }
  }
  if (action === 'logout' && id) {
    await client.oauth.logout(id as import('@ferry/shared').OAuthProviderId);
    writeResult(json, { providerId: id, connected: false }, `Logged out of ${id}.\n`);
    return 0;
  }
  if (action !== 'list')
    throw new CliError(2, 'Usage: ferry oauth list | login <id> | logout <id>');
  const rows = await client.oauth.list();
  writeResult(
    json,
    rows,
    rows
      .map(
        (row) =>
          `${row.connected ? good('●') : muted('○')} ${row.id} · ${row.name} · unofficial · suspension risk`,
      )
      .join('\n') + '\n',
  );
  return 0;
}
async function profiles(client: FerryClient, args: string[], json = false) {
  const [action, name] = args;
  const rows = await client.profiles.list();
  if (action === 'use' && name) {
    const profile = rows.find((item) => item.name === name);
    if (!profile) throw new Error(`Profile not found: ${name}`);
    await client.profiles.activate(profile.id);
    writeResult(json, { activeProfileId: profile.id, name: profile.name }, '');
    return 0;
  }
  writeResult(json, rows, rows.map((p) => `${p.name} · ${p.description}`).join('\n') + '\n');
  return 0;
}
async function skills(client: FerryClient, args: string[], json = false) {
  const [action, id] = args;
  const rows = await client.skills.list();
  if ((action === 'enable' || action === 'disable') && id) {
    const skill = rows.find((item) => item.id === id);
    if (!skill) throw new Error(`Skill not found: ${id}`);
    await client.skills.setEnabled(skill.id, action === 'enable');
    writeResult(json, { skillId: id, enabled: action === 'enable' }, '');
    return 0;
  }
  writeResult(
    json,
    rows,
    rows.map((s) => `${s.enabled ? '●' : '○'} ${s.name} · ${s.description}`).join('\n') + '\n',
  );
  return 0;
}
async function lanes(client: FerryClient, args: string[], json = false) {
  const rows =
    args[0] === 'approve'
      ? await client.delegation.approveProjectLanes()
      : await client.delegation.lanes();
  writeResult(
    json,
    rows,
    rows.map((row) => `${row.trusted ? '✓' : '○'} ${row.name} · ${row.implementer}`).join('\n') +
      '\n',
  );
  return 0;
}
async function listDomain(client: FerryClient, domain: 'mcp', json = false) {
  const rows = await client[domain].list();
  writeResult(json, rows, rows.map((item) => `${item.name} · ${item.status}`).join('\n') + '\n');
  return 0;
}
async function resume(client: FerryClient, id: string | undefined, json: boolean) {
  if (!id) throw new CliError(2, 'Usage: ferry resume <sessionId>');
  const session = await client.sessions.get(id as import('@ferry/shared').SessionId);
  if (json)
    process.stdout.write(
      JSON.stringify({ type: 'session.message', sessionId: id, messages: session.messages }) + '\n',
    );
  else
    for (const message of session.messages)
      for (const part of message.parts)
        if (part.type === 'text') process.stdout.write(`${message.role}: ${part.text}\n`);
  return 0;
}
async function keys(client: FerryClient, args: string[], json = false) {
  const [action, id] = args;
  if (action === 'remove' && id) {
    await client.providers.removeKey(id as import('@ferry/shared').ProviderId);
    writeResult(json, { removed: true, providerId: id }, '');
    return 0;
  }
  if (action !== 'set' || !id)
    throw new CliError(2, 'Usage: ferry keys set <provider> | remove <provider>');
  const key = await readSecret(json);
  if (!key) throw new CliError(2, 'No key received; enter a key or provide input on stdin.');
  await client.providers.setKey(id as import('@ferry/shared').ProviderId, key);
  writeResult(json, { saved: true, providerId: id }, 'Key saved.\n');
  return 0;
}
async function readSecret(silent = false): Promise<string> {
  const { stdin, stdout } = process;
  if (!silent) stdout.write('API key: ');
  if (!stdin.isTTY || !stdin.setRawMode) {
    const { createInterface } = await import('node:readline');
    const rl = createInterface({ input: stdin, terminal: false });
    const line = await new Promise<string | null>((resolve) => {
      let settled = false;
      rl.once('line', (value) => {
        settled = true;
        resolve(value);
      });
      rl.once('close', () => {
        if (!settled) resolve(null);
      });
    });
    rl.close();
    return line ?? '';
  }
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve) => {
    let value = '';
    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.off('data', onData);
      stdout.write('\n');
    };
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\r' || char === '\n') {
          cleanup();
          resolve(value);
          return;
        }
        if (char === '\u0003') {
          cleanup();
          resolve('');
          return;
        }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char >= ' ') value += char;
      }
    };
    stdin.on('data', onData);
  });
}
export async function doctor(
  dataDir?: string,
  probes?: import('./doctor.js').DoctorProbes,
  json = false,
): Promise<number> {
  const rows = await collectDoctor({
    ...(probes ?? {}),
    dataDirectory: probes?.dataDirectory ?? dataDir ?? join(homedir(), '.ferry'),
  });
  if (json) process.stdout.write(`${JSON.stringify(rows)}\n`);
  else
    for (const row of rows)
      process.stdout.write(`${row.status.toUpperCase().padEnd(4)} ${row.name}: ${row.reason}\n`);
  return rows.some((row) => row.status === 'fail') ? 1 : 0;
}
async function runInit(
  client: FerryClient,
  cwd: string,
  yes: boolean,
  json = false,
): Promise<number> {
  const { initDefaults } = await import('./init.js');
  if (json) {
    await initDefaults(client, cwd);
    writeResult(json, { initialized: true, config: join(cwd, '.ferry', 'config.json') }, '');
    return 0;
  }
  if (yes) {
    await initDefaults(client, cwd);
    process.stdout.write(`Initialized .ferry/config.json with detected checks.\n`);
    return 0;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write('ferry init needs a TTY; pass --yes to accept recommended defaults.\n');
    return 2;
  }
  const { launchInitWizard } = await import('./init-prompt.js');
  await launchInitWizard(client, cwd);
  return 0;
}
