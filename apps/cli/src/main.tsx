import { defineCommand, runMain } from 'citty';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { createClientAsync } from './client.js';
import { good, muted, warn } from './colors.js';
import {
  clearGatewayStatus,
  createGatewayToken,
  gatewayDataDir,
  getGatewayDaemonStatus,
  listGatewayTokens,
  revokeGatewayToken,
  startGatewayDaemon,
  stopGatewayDaemon,
  writeGatewayStatus,
} from './gateway.js';
import { collectDoctor } from './doctor.js';
import type { FerryClient } from '@ferry/client';
import {
  ModelRefSchema,
  RoutingSettingsSchema,
  type MessagePart,
  type Profile,
  type Provider,
  type Session,
} from '@ferry/shared';

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
    mock?: boolean;
    yesPaid?: boolean;
    verbose?: boolean;
    quiet?: boolean;
    modelRef?: string;
    onSessionCreated?: (session: Session) => void;
    onEvent?: (event: Record<string, unknown>) => void;
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
  if (options.modelRef)
    await client.models.select(session.id, ModelRefSchema.parse(options.modelRef));
  options.onSessionCreated?.(session);
  const publish = (event: Record<string, unknown>, human?: string) => {
    options.onEvent?.(event);
    if (!options.quiet) emit(json, event, human);
  };
  let approvalNeeded = false;
  let paidCapReached = false;
  let failed = false;
  let stepLimitExceeded = false;
  let terminalStatusEmitted = false;
  let observedSteps = 0;
  const seenParts = new Set<string>();
  let finishRun!: () => void;
  const done = new Promise<void>((resolve) => {
    finishRun = resolve;
  });
  const disposers = [
    client.on('session.delta', (event) => {
      if (event.sessionId !== session.id) return;
      publish({ type: 'session.delta', ...event }, event.textDelta);
    }),
    client.on('session.part', (event) => {
      if (event.sessionId !== session.id) return;
      if (event.part.type === 'approval_request' && event.part.state === 'pending') {
        const mode = options.permission ?? settings.permissionMode;
        if (event.part.kind === 'paid_model' && options.yesPaid) {
          void client.approvals.respond(session.id, event.part.id, 'allow_once');
        } else if (
          event.part.kind === 'paid_model' &&
          process.stdin.isTTY &&
          process.stdout.isTTY
        ) {
          void askPaidApproval(event.part.summary).then((decision) => {
            if (decision === 'deny') approvalNeeded = true;
            return client.approvals.respond(session.id, event.part.id, decision);
          });
        } else if (event.part.kind === 'paid_model') {
          approvalNeeded = true;
          if (!options.quiet)
            process.stderr.write(
              'Paid model confirmation is required in a TTY, or pass --yes-paid. No paid request was sent.\n',
            );
          void client.approvals.respond(session.id, event.part.id, 'deny');
        } else if (mode === 'full_auto' || (mode === 'auto_edit' && event.part.kind === 'edit')) {
          void client.approvals.respond(
            session.id,
            event.part.id,
            mode === 'full_auto' ? 'allow_always' : 'allow_once',
          );
        } else if (process.stdin.isTTY && process.stdout.isTTY) {
          void askApproval(event.part.summary, event.part.detail).then((decision) => {
            if (!decision || decision === 'deny') approvalNeeded = true;
            return client.approvals.respond(session.id, event.part.id, decision ?? 'deny');
          });
        } else {
          approvalNeeded = true;
          void client.sessions.cancel(session.id);
        }
      }
      if (event.part.type === 'error') {
        failed = true;
        if (event.part.message.startsWith('Paid cap reached:')) paidCapReached = true;
        if (!options.quiet && options.verbose && event.part.details)
          process.stderr.write(`Routing exclusions: ${formatRoutingDetails(event.part.details)}\n`);
      }
      if (event.part.type === 'tool_call' && !seenParts.has(event.part.id)) {
        seenParts.add(event.part.id);
        observedSteps++;
        // Mock clients do not enforce engine step budgets; preserve CLI behavior without
        // cancelling through a second RPC. The local engine reports its own clean limit.
        if (options.mock && options.maxSteps !== undefined && observedSteps > options.maxSteps)
          stepLimitExceeded = true;
      }
      publish({ type: 'session.part', ...event }, summarize(event.part));
    }),
    client.on('session.message', (event) => {
      if (event.sessionId === session.id) publish({ type: 'session.message', ...event });
    }),
    client.on('routing.explain', (event) => {
      if (!options.verbose) return;
      if (!options.quiet) process.stderr.write(`Router explain: ${JSON.stringify(event)}\n`);
      publish({ type: 'routing.explain', payload: event });
    }),
    client.on('task.updated', (event) => publish({ type: 'task.updated', payload: event })),
    client.on('quota.updated', (event) => publish({ type: 'quota.updated', payload: event })),
    client.on('provider.updated', (event) => publish({ type: 'provider.updated', payload: event })),
    client.on('delegation.updated', (event) =>
      publish({ type: 'delegation.updated', payload: event }),
    ),
    client.on('toast', (event) => {
      const message = 'title' in event && typeof event.title === 'string' ? event.title : '';
      if (message.startsWith('FERRY_RUN_LIMIT:max_steps:')) stepLimitExceeded = true;
      publish({ type: 'toast', payload: event });
    }),
  ];
  disposers.push(
    client.on('session.status', (value) => {
      if (value.id !== session.id) return;
      if (['idle', 'error', 'paused'].includes(value.status)) {
        if (!terminalStatusEmitted) publish({ type: 'session.status', session: value });
        terminalStatusEmitted = true;
        finishRun();
      } else publish({ type: 'session.status', session: value });
    }),
    client.on('session.updated', (value) => {
      if (value.id !== session.id || !['idle', 'error', 'paused'].includes(value.status)) return;
      if (!terminalStatusEmitted) {
        publish({ type: 'session.status', session: value });
        terminalStatusEmitted = true;
      }
      finishRun();
    }),
  );
  try {
    await client.sessions.send(session.id, {
      text: prompt,
      ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
      ...(options.verbose ? { verbose: true } : {}),
    });
    await done;
  } finally {
    disposers.forEach((off) => off());
    if (options.permission)
      await client.settings.update({ permissionMode: settings.permissionMode });
  }
  if (stepLimitExceeded) {
    if (!options.quiet)
      process.stderr.write(
        `Maximum step count (${options.maxSteps}) reached; session ended cleanly.\n`,
      );
    return 4;
  }
  if (approvalNeeded) return 3;
  if (paidCapReached) return 5;
  return failed ? 1 : 0;
}

function emit(json: boolean, event: Record<string, unknown>, human?: string) {
  if (json) process.stdout.write(`${JSON.stringify(event)}\n`);
  else if (human) process.stdout.write(`${human}\n`);
}
async function askApproval(
  summary: string,
  detail: string,
): Promise<'allow_once' | 'allow_always' | 'deny' | null> {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stderr.write(`\n${detail}\n`);
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
async function askPaidApproval(summary: string): Promise<'allow_once' | 'deny'> {
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await terminal.question(`Paid call: ${summary} [y/N] `)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes' ? 'allow_once' : 'deny';
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

export function formatRoutingDetails(
  details: NonNullable<Extract<MessagePart, { type: 'error' }>['details']>,
): string {
  const attempts = details.attempts.map(
    (attempt) =>
      `${attempt.provider ?? attempt.model.split('/')[0] ?? 'provider'} · ${attempt.model}: ${attempt.kind}${attempt.status === null ? '' : ` (HTTP ${String(attempt.status)})`} · ${String(attempt.latencyMs ?? 0)} ms — ${attempt.message}`,
  );
  const shown = attempts.slice(0, 12);
  if (attempts.length > shown.length)
    shown.push(`${String(attempts.length - shown.length)} more attempts`);
  return shown.join('; ') || 'No model attempts recorded';
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
    const engine =
      command === 'serve' && flags.values.gateway === true
        ? 'local'
        : (flags.values.engine ?? (process.env.FERRY_ENGINE === 'mock' ? 'mock' : 'local'));
    if (engine !== 'mock' && engine !== 'local')
      throw new CliError(2, 'Invalid --engine. Use mock or local.');
    if (command === 'run') validateRunArguments(flags);
    if (command === 'resume' && !flags.positionals[1])
      throw new CliError(2, 'Usage: ferry resume <sessionId>');
    if (command && !CLI_COMMANDS.has(command)) throw new CliError(2, `Unknown command: ${command}`);
    if (command === 'oauth' && flags.positionals[1] === 'login') {
      const id = flags.positionals[2];
      if (!id) throw new CliError(2, 'Usage: ferry oauth login <id>');
      if (['kilo', 'qoder', 'cline', 'gemini-cli', 'antigravity'].includes(id))
        throw new CliError(2, `OAuth login is unavailable for ${id}.`);
      if (
        id !== 'openrouter' &&
        id !== 'radius' &&
        (!process.stdin.isTTY || !process.stdout.isTTY) &&
        flags.values['i-understand-the-risk'] !== true
      )
        throw new CliError(2, 'Non-interactive OAuth login requires --i-understand-the-risk.');
    }
    if (command === 'gateway')
      return await gatewayCommand(flags.positionals.slice(1), json, gatewayDataDir(dataDir));
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
      if (engine === 'local') await assertLocalProvidersConfigured(client);
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
          mock: engine === 'mock',
          ...(flags.values['yes-paid'] === true ? { yesPaid: true } : {}),
          ...(typeof flags.values['model-ref'] === 'string'
            ? { modelRef: flags.values['model-ref'] }
            : {}),
        },
      );
      return code;
    }
    if (command === 'resume')
      return await resume(client, flags.positionals[1], json, flags.values['retry-tool'] === true);
    if (command === 'serve') {
      if (flags.values.gateway === true) {
        const status = await client.gateway.start();
        const serverStatus = status as { port?: number; host?: string; url?: string };
        await writeGatewayStatus(gatewayDataDir(dataDir), {
          port: serverStatus.port ?? 11435,
          host: serverStatus.host ?? '127.0.0.1',
          url: serverStatus.url ?? 'http://127.0.0.1:11435',
        });
        writeResult(
          json,
          status,
          `Ferry Gateway running at ${(status as { url?: string }).url ?? 'localhost'}\nPress Ctrl+C to stop.\n`,
        );
        await waitForShutdownSignal();
        await clearGatewayStatus(gatewayDataDir(dataDir));
        return 0;
      }
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
    if (command === 'oauth')
      return await oauth(
        client,
        flags.positionals.slice(1),
        json,
        flags.values['i-understand-the-risk'] === true,
      );
    if (command === 'profiles') return await profiles(client, flags.positionals.slice(1), json);
    if (command === 'skills') return await skills(client, flags.positionals.slice(1), json);
    if (command === 'mcp') return await listDomain(client, 'mcp', json);
    if (command === 'lanes') return await lanes(client, flags.positionals.slice(1), json);
    if (command === 'optimize') {
      const stats = await client.optimizer.stats();
      writeResult(json, stats, JSON.stringify(stats, null, 2) + '\n');
      return 0;
    }
    if (command === 'doctor') {
      if (flags.values.providers === true) return await doctorProviders(client, json);
      return await doctor(dataDir, undefined, json);
    }
    if (command === 'status') {
      const providers = await client.providers.list();
      const configured = providers.some(isProviderConfigured);
      writeResult(
        json,
        { engine, providersConfigured: configured },
        `Engine: ${engine}\nProviders configured: ${configured ? 'yes' : 'no'}\n`,
      );
      return 0;
    }
    if (command === 'keys') return await keys(client, flags.positionals.slice(1), json);
    if (command === 'settings')
      return await routingSettings(client, flags.positionals.slice(1), json);
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

async function assertLocalProvidersConfigured(client: FerryClient): Promise<void> {
  const providers = await client.providers.list();
  const configured = providers.some(isProviderConfigured);
  if (!configured)
    throw new CliError(
      1,
      'No providers configured — run `ferry` setup / add a key in the Ferry app.',
    );
}

function isProviderConfigured(provider: Provider): boolean {
  return (
    provider.enabled &&
    (provider.keyStatus !== 'missing' || (!provider.keyRequired && provider.modelCount > 0))
  );
}

function writeResult(json: boolean, value: unknown, human: string): void {
  process.stdout.write(json ? `${JSON.stringify(value)}\n` : human);
}

export async function main(): Promise<void> {
  const command = defineCommand({
    meta: {
      name: 'ferry',
      version: process.env.FERRY_RELEASE_VERSION ?? '0.9.0',
      description: [
        'Ferry coding agent CLI',
        `Active engine: ${process.env.FERRY_ENGINE === 'mock' ? 'mock' : 'local'} (override with --engine mock|local)`,
        '',
        'Commands:',
        '  run <prompt> [--model-ref ref] [--yes-paid]  Run a task with an optional explicit model',
        '  status                                        Show engine and provider status',
        '  serve --gateway                              Run Ferry core and Gateway in the foreground',
        '  gateway start|stop|status                    Manage the local Gateway',
        '  gateway keys create <name> [profile]         Create a Gateway key (shown once)',
        '  gateway keys list|revoke <key-id>            List or revoke Gateway keys',
      ].join('\n'),
    },
    run: async () => {
      const exitCode = await runCli();
      if (process.env.FERRY_E2E_HANDLE_DIAGNOSTICS === '1') {
        process.stderr.write(
          `FERRY_ACTIVE_RESOURCES:${JSON.stringify(process.getActiveResourcesInfo())}\n`,
        );
      }
      await new Promise<void>((resolve) => process.stdout.write('', () => resolve()));
      await new Promise<void>((resolve) => process.stderr.write('', () => resolve()));
      process.exit(exitCode);
    },
  });
  await runMain(command);
}

type Flags = { positionals: string[]; values: Record<string, string | boolean> };
const CLI_COMMANDS = new Set([
  'run',
  'resume',
  'serve',
  'gateway',
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
  'settings',
  'init',
  'status',
]);

async function gatewayCommand(args: string[], json: boolean, dataDir: string): Promise<number> {
  const [action, subcommand, ...rest] = args;
  if (action === 'start') {
    const status = await startGatewayDaemon(dataDir);
    writeResult(json, status, `Ferry Gateway running at ${status.url}\n`);
    return 0;
  }
  if (action === 'stop') {
    const stopped = await stopGatewayDaemon(dataDir);
    writeResult(
      json,
      { running: false, stopped },
      stopped ? 'Ferry Gateway stopped\n' : 'Ferry Gateway was not running\n',
    );
    return 0;
  }
  if (action === 'status') {
    const status = await getGatewayDaemonStatus(dataDir);
    writeResult(
      json,
      status ?? { running: false },
      status ? `Running at ${status.url}\n` : 'Stopped\n',
    );
    return 0;
  }
  if (action === 'keys' && subcommand === 'list') {
    const keys = await listGatewayTokens(dataDir);
    writeResult(
      json,
      keys,
      keys
        .map(
          (key) =>
            `${key.id} ${key.name} ${key.profile} · ${gatewayUsageRequests(key.usage)} requests`,
        )
        .join('\n') + '\n',
    );
    return 0;
  }
  if (action === 'keys' && subcommand === 'create') {
    const [name, profile = 'auto-free'] = rest;
    if (!name) throw new CliError(2, 'Usage: ferry gateway keys create <name> [profile]');
    const created = await createGatewayToken(dataDir, name, profile);
    writeResult(json, created, `Key shown once; copy it now:\n${created.secret}\n`);
    return 0;
  }
  if (action === 'keys' && subcommand === 'revoke') {
    const id = rest[0];
    if (!id) throw new CliError(2, 'Usage: ferry gateway keys revoke <id>');
    if (!(await revokeGatewayToken(dataDir, id)))
      throw new CliError(2, `Gateway key not found: ${id}`);
    writeResult(json, { revoked: id }, `Revoked ${id}\n`);
    return 0;
  }
  throw new CliError(2, 'Usage: ferry gateway start|stop|status|keys create|list|revoke');
}

function gatewayUsageRequests(usage: unknown): number {
  if (!usage || typeof usage !== 'object' || !('requests' in usage)) return 0;
  const requests = usage.requests;
  return typeof requests === 'number' && Number.isFinite(requests) ? requests : 0;
}

async function waitForShutdownSignal(): Promise<void> {
  await new Promise<void>((resolve) => {
    const finish = () => {
      process.off('SIGINT', finish);
      process.off('SIGTERM', finish);
      resolve();
    };
    process.once('SIGINT', finish);
    process.once('SIGTERM', finish);
  });
}
const VALUE_FLAGS = new Set([
  'cwd',
  'profile',
  'data-dir',
  'engine',
  'permission',
  'max-steps',
  'delegation',
  'model',
  'model-ref',
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
    else if (key === 'yes-paid') values[key] = true;
    else if (argv[i + 1] && !argv[i + 1]?.startsWith('--')) values[key] = argv[++i] ?? '';
    else if (VALUE_FLAGS.has(key)) throw new CliError(2, `Missing value for --${key}`);
    else values[key] = true;
  }
  return { positionals, values };
}

const routingToggleKeys = {
  'sticky-sessions': 'stickySessions',
  'smart-reliability': 'smartReliability',
  'quota-reservations': 'quotaReservations',
  'cooldown-reasons': 'cooldownReasons',
  'gentle-quota-ramp': 'gentleQuotaRamp',
  'tool-rejection-memory': 'toolRejectionMemory',
  'careful-model-retirement': 'carefulModelRetirement',
} as const;

export async function routingSettings(
  client: FerryClient,
  args: string[],
  json: boolean,
): Promise<number> {
  const [area, action, key, value] = args;
  if (area !== 'routing')
    throw new CliError(2, 'Usage: ferry settings routing list|set <key> on|off');
  const settings = await client.settings.get();
  const routing = RoutingSettingsSchema.parse(settings.routing);
  if (action === 'list' && key === undefined) {
    const rows = Object.fromEntries(
      Object.entries(routing).map(([name, value]) => [
        name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`),
        value,
      ]),
    );
    writeResult(
      json,
      rows,
      Object.entries(rows)
        .map(([name, enabled]) => `${name}: ${String(enabled)}`)
        .join('\n') + '\n',
    );
    return 0;
  }
  if (
    action === 'set' &&
    key &&
    value &&
    key in routingToggleKeys &&
    (value === 'on' || value === 'off')
  ) {
    const settingKey = routingToggleKeys[key as keyof typeof routingToggleKeys];
    const updated = await client.settings.update({
      routing: { ...routing, [settingKey]: value === 'on' },
    });
    const result = { key, enabled: updated.routing[settingKey] };
    writeResult(json, result, `${key}: ${value}\n`);
    return 0;
  }
  throw new CliError(2, 'Usage: ferry settings routing list|set <key> on|off');
}
function validateFlags(values: Record<string, string | boolean>): void {
  for (const key of VALUE_FLAGS) {
    const value = values[key];
    if (value === '') throw new CliError(2, `Missing value for --${key}`);
  }
}
function validateRunArguments(flags: Flags): void {
  if (!flags.positionals.slice(1).join(' ')) throw new CliError(2, 'Usage: ferry run <prompt>');
  const modelRef = flags.values['model-ref'];
  if (typeof modelRef === 'string' && !ModelRefSchema.safeParse(modelRef).success)
    throw new CliError(2, 'Invalid --model-ref. Use a provider/model reference.');
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

async function oauth(
  client: FerryClient,
  args: string[],
  json = false,
  riskAcknowledged = false,
): Promise<number> {
  const [action, id] = args;
  if (action === 'login' && id) {
    const provider = (await client.oauth.list()).find((item) => item.id === id);
    if (!provider) throw new CliError(2, `Unknown subscription OAuth provider: ${id}`);
    if (provider.actionAvailable === false)
      throw new CliError(2, `${provider.name} login is unavailable.`);
    if (
      provider.riskLevel === 'high' &&
      (!process.stdin.isTTY || !process.stdout.isTTY) &&
      !riskAcknowledged
    )
      throw new CliError(2, 'Non-interactive OAuth login requires --i-understand-the-risk.');
    if (provider.riskLevel === 'high' && (!process.stdin.isTTY || !process.stdout.isTTY)) {
      // The risk flag above is the acknowledgement for headless invocations.
    } else if (provider.riskLevel === 'high') {
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
    await client.oauth.logout(id);
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
          `${row.status === 'expired' ? warn('!') : row.connected ? good('●') : muted('○')} ${row.id} · ${row.name} · ${row.connected ? `connected${row.account ? ` as ${row.account}` : ''}` : row.status === 'expired' ? 'expired' : 'not connected'} · ${row.riskLevel} risk${row.models.length ? ` · ${row.models.length} models` : ''}`,
      )
      .join('\n') + '\n',
  );
  return 0;
}
async function profiles(client: FerryClient, args: string[], json = false) {
  const [action, name] = args;
  const rows = await client.profiles.list();
  if (action === 'roles') {
    const roleAction = args[1];
    const profileName = args[2] ?? 'Auto-Free';
    const profile = rows.find((item) => item.name.toLowerCase() === profileName.toLowerCase());
    if (!profile) throw new CliError(2, `Profile not found: ${profileName}`);
    if (roleAction === 'set') {
      const enabled = args[3];
      if (enabled !== 'on' && enabled !== 'off')
        throw new CliError(
          2,
          'Usage: ferry profiles roles set <profile> on|off [planner=auto|model editor=auto|model]',
        );
      const values = Object.fromEntries(
        args.slice(4).map((value) => {
          const separator = value.indexOf('=');
          if (separator < 1) throw new CliError(2, `Invalid role option: ${value}`);
          return [value.slice(0, separator), value.slice(separator + 1)];
        }),
      );
      const saved = await client.profiles.save({
        ...profile,
        roles: {
          ...profile.roles,
          enabled: enabled === 'on',
          ...(values.planner === undefined
            ? {}
            : { plannerModelRef: values.planner === 'auto' ? null : values.planner }),
          ...(values.editor === undefined
            ? {}
            : { editorModelRef: values.editor === 'auto' ? null : values.editor }),
        },
      });
      writeResult(
        json,
        { profile: saved.name, roles: saved.roles },
        `Saved planner/editor roles for ${saved.name}.\n`,
      );
      return 0;
    }
    if (roleAction !== 'show')
      throw new CliError(
        2,
        'Usage: ferry profiles roles show [profile] | set <profile> on|off [planner=auto|model editor=auto|model]',
      );
    writeResult(
      json,
      { profile: profile.name, roles: profile.roles },
      `${profile.name}: ${profile.roles.enabled ? 'on' : 'off'} (planner=${profile.roles.plannerModelRef ?? 'auto'}, editor=${profile.roles.editorModelRef ?? 'auto'})\n`,
    );
    return 0;
  }
  if (action === 'chain') {
    const chainAction = args[1];
    const profileName = args[2] ?? 'Auto-Free';
    const profile = rows.find((item) => item.name.toLowerCase() === profileName.toLowerCase());
    if (!profile) throw new CliError(2, `Profile not found: ${profileName}`);
    if (chainAction === 'set') {
      const assignments = args.slice(3).map((value) => {
        const separator = value.indexOf('=');
        if (separator < 1) throw new CliError(2, `Invalid chain entry: ${value}`);
        const provider = value.slice(0, separator);
        const patterns = value
          .slice(separator + 1)
          .split(',')
          .map((pattern) => pattern.trim())
          .filter(Boolean);
        if (!patterns.length) throw new CliError(2, `No model patterns provided for ${provider}`);
        return {
          provider: provider as NonNullable<Profile['fallbackChain']>[number]['provider'],
          patterns,
        };
      });
      if (!assignments.length)
        throw new CliError(
          2,
          'Usage: ferry profiles chain set <profile> <provider=pattern,pattern> [...entries]',
        );
      const saved = await client.profiles.save({ ...profile, fallbackChain: assignments });
      writeResult(
        json,
        { profile: saved.name, fallbackChain: saved.fallbackChain },
        `Saved fallback order for ${saved.name}.\n`,
      );
      return 0;
    }
    if (chainAction !== 'show')
      throw new CliError(
        2,
        'Usage: ferry profiles chain show [profile] | set <profile> <provider=pattern,...>',
      );
    const chain = profile.fallbackChain ?? [];
    writeResult(
      json,
      { profile: profile.name, fallbackChain: chain },
      chain
        .map(
          (entry, index) => `${String(index + 1)}. ${entry.provider}=${entry.patterns.join(',')}`,
        )
        .join('\n') + '\n',
    );
    return 0;
  }
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
async function resume(
  client: FerryClient,
  id: string | undefined,
  json: boolean,
  retryTool = false,
) {
  if (!id) throw new CliError(2, 'Usage: ferry resume <sessionId> [--retry-tool]');
  const sessionId = id as import('@ferry/shared').SessionId;
  const detail = await client.sessions.get(sessionId);
  const pendingTools = detail.messages
    .flatMap((message) => message.parts)
    .filter((part) => part.type === 'tool_call' && part.status === 'running');
  if (pendingTools.length && !retryTool) {
    if (!process.stdin.isTTY || !process.stdout.isTTY)
      throw new CliError(
        2,
        'A tool was interrupted. Resume with --retry-tool only if you approve running it again.',
      );
    const terminal = createInterface({ input: process.stdin, output: process.stderr });
    try {
      const names = pendingTools
        .map((part) => (part.type === 'tool_call' ? part.title : ''))
        .join(', ');
      const answer = (
        await terminal.question('Ferry stopped while ' + names + ' was running. Retry it? [y/N] ')
      )
        .trim()
        .toLowerCase();
      if (answer !== 'y' && answer !== 'yes') return 2;
      retryTool = true;
    } finally {
      terminal.close();
    }
  }
  let running = false;
  let settle!: () => void;
  const completed = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const observeStatus = (value: Session) => {
    if (value.id !== sessionId) return;
    if (value.status === 'running') running = true;
    else if (running && (value.status === 'idle' || value.status === 'error')) settle();
  };
  const stopStatus = client.on('session.status', observeStatus);
  const stopUpdated = client.on('session.updated', observeStatus);
  try {
    await client.sessions.resume(sessionId, { retryInterruptedTool: retryTool });
    if (json)
      process.stdout.write(
        JSON.stringify({ type: 'session.message', sessionId, messages: detail.messages }) + '\n',
      );
    else {
      process.stdout.write('Resuming ' + detail.session.title + '\n');
      for (const message of detail.messages)
        for (const part of message.parts)
          if (part.type === 'text') process.stdout.write(message.role + ': ' + part.text + '\n');
    }
    const after = await client.sessions.get(sessionId);
    if (after.session.status === 'idle' || after.session.status === 'error')
      return after.session.status === 'error' ? 1 : 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        completed,
        new Promise<void>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new CliError(1, 'Resume timed out while waiting for the core.')),
            300_000,
          );
        }),
      ]);
      return 0;
    } finally {
      if (timer) clearTimeout(timer);
    }
  } finally {
    stopStatus();
    stopUpdated();
  }
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

async function doctorProviders(client: FerryClient, json: boolean): Promise<number> {
  const providers = await client.providers.list();
  const report = providers.map((provider) => ({
    provider: provider.id,
    health: provider.health,
    keyStatus: provider.keyStatus,
    enabled: provider.enabled,
    cooldownUntil: provider.cooldownUntil,
    modelCount: provider.modelCount,
  }));
  if (json) process.stdout.write(`${JSON.stringify(report)}\n`);
  else
    for (const provider of report)
      process.stdout.write(
        `${provider.health.toUpperCase().padEnd(8)} ${provider.provider} · ${provider.keyStatus}${provider.cooldownUntil ? ` · reset ${provider.cooldownUntil}` : ''} · ${provider.modelCount} models\n`,
      );
  return report.some(
    (provider) =>
      provider.enabled && ['down', 'auth_invalid', 'account_disabled'].includes(provider.health),
  )
    ? 1
    : 0;
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
