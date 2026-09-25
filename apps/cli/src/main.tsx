import React from 'react';
import { render } from 'ink';
import { defineCommand, runMain } from 'citty';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { createClientAsync } from './client.js';
import { Chat } from './tui.js';
import { gradient, good, muted, warn } from './format.js';
import { collectDoctor } from './doctor.js';
import { InitWizard, initDefaults } from './init.js';
import type { FerryClient } from '@ferry/client';

/* Event handlers intentionally return promises to the event emitter; the parser narrows argv flags. */
/* eslint-disable @typescript-eslint/no-confusing-void-expression, @typescript-eslint/no-unnecessary-condition, @typescript-eslint/return-await, @typescript-eslint/consistent-type-definitions, @typescript-eslint/restrict-template-expressions */

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

export async function runPrompt(
  client: FerryClient,
  prompt: string,
  json: boolean,
  profileName?: string,
  cwd = process.cwd(),
  options: { permission?: 'ask' | 'auto_edit' | 'full_auto'; maxSteps?: number } = {},
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
      if (event.part.type === 'error') failed = true;
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

export async function runCli(argv = process.argv.slice(2)): Promise<number> {
  const flags = readFlags(argv);
  const command = flags.positionals[0];
  const dataDir = stringFlag(flags.values['data-dir']);
  const cwd = stringFlag(flags.values.cwd) ?? process.cwd();
  const client = await createClientAsync({
    engine: flags.values.engine === 'local' ? 'local' : 'mock',
    ...(dataDir ? { dataDir } : {}),
  });
  try {
    if (!command) {
      await interactive(client, cwd);
      return 0;
    }
    if (command === 'run') {
      const prompt = flags.positionals.slice(1).join(' ');
      if (!prompt) return 2;
      if (
        typeof flags.values.permission === 'string' &&
        !['ask', 'auto_edit', 'full_auto'].includes(flags.values.permission)
      )
        return 2;
      if (
        typeof flags.values['max-steps'] === 'string' &&
        (!/^\d+$/.test(flags.values['max-steps']) || Number(flags.values['max-steps']) < 1)
      )
        return 2;
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
        },
      );
      return code;
    }
    if (command === 'resume')
      return resume(client, flags.positionals[1], flags.values.json === true);
    if (command === 'serve') {
      process.stdout.write('engine transport coming in B0\n');
      return 0;
    }
    if (command === 'quota')
      return flags.values.watch === true
        ? quotaWatch(client)
        : quota(client, flags.values.json === true);
    if (command === 'providers') return providers(client, flags.positionals.slice(1));
    if (command === 'profiles') return profiles(client, flags.positionals.slice(1));
    if (command === 'skills') return skills(client, flags.positionals.slice(1));
    if (command === 'mcp') return listDomain(client, 'mcp');
    if (command === 'lanes') return lanes(client, flags.positionals.slice(1));
    if (command === 'optimize') {
      process.stdout.write(JSON.stringify(await client.optimizer.stats(), null, 2) + '\n');
      return 0;
    }
    if (command === 'doctor') return doctor(dataDir);
    if (command === 'keys') return keys(client, flags.positionals.slice(1));
    if (command === 'init') return runInit(client, cwd, flags.values.yes === true);
    process.stderr.write(`Unknown command: ${command}\n`);
    return 2;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    await client.dispose?.();
  }
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
    else values[key] = true;
  }
  return { positionals, values };
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
async function quotaWatch(client: FerryClient): Promise<number> {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) return quota(client, false);
  let snapshot = await client.quota.capacity();
  const redraw = () => {
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
    process.stdout.write('\nPress q or Ctrl+C to exit.\n');
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
async function providers(client: FerryClient, args: string[]) {
  const [action, id] = args;
  const rows = await client.providers.list();
  if (action === 'test' && id) {
    const result = await client.providers.probe(id as import('@ferry/shared').ProviderId);
    process.stdout.write(`${result.ok ? good('OK') : warn('CHECK')} ${result.message}\n`);
    return result.ok ? 0 : 1;
  }
  if ((action === 'enable' || action === 'disable') && id) {
    await client.providers.setEnabled(
      id as import('@ferry/shared').ProviderId,
      action === 'enable',
    );
    return 0;
  }
  process.stdout.write(
    rows
      .map((p) => `${p.enabled ? good('●') : muted('○')} ${p.id} · ${p.name} · ${p.keyStatus}`)
      .join('\n') + '\n',
  );
  return 0;
}
async function profiles(client: FerryClient, args: string[]) {
  const [action, name] = args;
  const rows = await client.profiles.list();
  if (action === 'use' && name) {
    const profile = rows.find((item) => item.name === name);
    if (!profile) return 1;
    await client.profiles.activate(profile.id);
    return 0;
  }
  process.stdout.write(rows.map((p) => `${p.name} · ${p.description}`).join('\n') + '\n');
  return 0;
}
async function skills(client: FerryClient, args: string[]) {
  const [action, id] = args;
  const rows = await client.skills.list();
  if ((action === 'enable' || action === 'disable') && id) {
    const skill = rows.find((item) => item.id === id);
    if (!skill) return 1;
    await client.skills.setEnabled(skill.id, action === 'enable');
    return 0;
  }
  process.stdout.write(
    rows.map((s) => `${s.enabled ? '●' : '○'} ${s.name} · ${s.description}`).join('\n') + '\n',
  );
  return 0;
}
async function lanes(client: FerryClient, args: string[]) {
  const rows =
    args[0] === 'approve'
      ? await client.delegation.approveProjectLanes()
      : await client.delegation.lanes();
  process.stdout.write(
    rows.map((row) => `${row.trusted ? '✓' : '○'} ${row.name} · ${row.implementer}`).join('\n') +
      '\n',
  );
  return 0;
}
async function listDomain(client: FerryClient, domain: 'mcp') {
  process.stdout.write(
    (await client[domain].list()).map((item) => `${item.name} · ${item.status}`).join('\n') + '\n',
  );
  return 0;
}
async function resume(client: FerryClient, id: string | undefined, json: boolean) {
  if (!id) return 2;
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
async function keys(client: FerryClient, args: string[]) {
  const [action, id] = args;
  if (action === 'remove' && id) {
    await client.providers.removeKey(id as import('@ferry/shared').ProviderId);
    return 0;
  }
  if (action !== 'set' || !id) return 2;
  const key = await readSecret();
  if (!key) return 2;
  await client.providers.setKey(id as import('@ferry/shared').ProviderId, key);
  process.stdout.write('Key saved.\n');
  return 0;
}
async function readSecret(): Promise<string> {
  const { stdin, stdout } = process;
  stdout.write('API key: ');
  if (!stdin.isTTY || !stdin.setRawMode) {
    const { createInterface } = await import('node:readline');
    const rl = createInterface({ input: stdin, terminal: false });
    const line = await new Promise<string>((resolve) => rl.once('line', resolve));
    rl.close();
    return line;
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
): Promise<number> {
  const rows = await collectDoctor({
    ...(probes ?? {}),
    dataDirectory: probes?.dataDirectory ?? dataDir ?? join(homedir(), '.ferry'),
  });
  for (const row of rows)
    process.stdout.write(`${row.status.toUpperCase().padEnd(4)} ${row.name}: ${row.reason}\n`);
  return rows.some((row) => row.status === 'fail') ? 1 : 0;
}
async function runInit(client: FerryClient, cwd: string, yes: boolean): Promise<number> {
  if (yes) {
    await initDefaults(client, cwd);
    process.stdout.write(`Initialized .ferry/config.json with detected checks.\n`);
    return 0;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write('ferry init needs a TTY; pass --yes to accept recommended defaults.\n');
    return 2;
  }
  const app = render(<InitWizard client={client} cwd={cwd} onDone={() => app.unmount()} />);
  await app.waitUntilExit();
  return 0;
}
