import { spawn } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { FerryClient } from '@ferry/client';
import { toolProcess } from './tool-process.js';
import {
  configuredContent,
  masked,
  toolConfigPath,
  toolLaunch,
  type SupportedTool,
  type ToolConnection,
} from './tool-config.js';

export interface ToolOptions {
  keyId?: string | undefined;
  model?: string | undefined;
  preview?: boolean;
  args?: string[];
  json?: boolean;
}
async function pick(
  label: string,
  choices: { id: string; label: string }[],
  fallback: string,
): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return fallback;
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  try {
    choices.forEach((choice, index) =>
      process.stderr.write(`${String(index + 1)}. ${choice.label}\n`),
    );
    for (;;) {
      const answer = (await terminal.question(`${label} [1]: `)).trim();
      if (!answer) return fallback;
      const choice = choices[Number(answer) - 1] ?? choices.find((item) => item.id === answer);
      if (choice) return choice.id;
      process.stderr.write('Select a listed number or ID.\n');
    }
  } finally {
    terminal.close();
  }
}
async function connection(
  client: FerryClient,
  tool: SupportedTool,
  options: ToolOptions,
): Promise<ToolConnection> {
  const keys = (await client.gateway.listKeys()).filter((key) => !key.revokedAt);
  let keyId = options.keyId;
  keyId ??= await pick(
    'Gateway key',
    [
      ...keys.map((key) => ({ id: key.id, label: `${key.name} (${key.id})` })),
      { id: 'new', label: 'Create a new key' },
    ],
    keys[0]?.id ?? 'new',
  );
  let secret: string;
  if (keyId === 'new') {
    const created = await client.gateway.createKey({ name: `${tool} CLI`, profile: 'auto-free' });
    keyId = created.key.id;
    secret = created.secret;
  } else {
    if (!keys.some((key) => key.id === keyId))
      throw new Error(`Unknown or revoked Gateway key: ${keyId}`);
    secret = await client.gateway.keySecret(keyId);
  }
  const selected = keys.find((key) => key.id === keyId);
  const allowed = selected?.allowedModels ?? [];
  const alias =
    selected?.profile && selected.profile !== 'none'
      ? `ferry/${selected.profile}`
      : 'ferry/auto-free';
  const models = allowed.length
    ? allowed
    : [alias, ...(await client.models.list()).map((model) => model.ref)];
  const model =
    options.model ??
    (await pick(
      'Model',
      models.map((id) => ({ id, label: id })),
      models[0] ?? alias,
    ));
  if (allowed.length && !allowed.includes(model))
    throw new Error(`Model is not allowed by Gateway key ${keyId}: ${model}`);
  const status = (await client.gateway.start()) as { url?: string; status?: { url?: string } };
  const url = status.url ?? status.status?.url;
  if (!url) throw new Error('Gateway did not return a running endpoint');
  return { url, secret, model };
}
export async function runTool(
  client: FerryClient,
  tool: SupportedTool,
  options: ToolOptions,
): Promise<number> {
  const selected = await connection(client, tool, options);
  const launch = toolLaunch(tool, selected, options.args);
  if (options.preview) {
    process.stdout.write(
      JSON.stringify(masked(launch, selected.secret), null, options.json ? undefined : 2) + '\n',
    );
    return 0;
  }
  const executable = await toolProcess(launch);
  return await new Promise<number>((resolve, reject) => {
    const child = spawn(executable.command, executable.args, {
      env: { ...process.env, ...launch.env },
      stdio: 'inherit',
      windowsHide: true,
      shell: false,
    });
    const interrupt = () => child.kill('SIGINT');
    process.on('SIGINT', interrupt);
    const cleanup = () => process.off('SIGINT', interrupt);
    child.once('error', (error) => {
      cleanup();
      reject(error);
    });
    child.once('exit', (code, signal) => {
      cleanup();
      resolve(code ?? (signal ? 1 : 0));
    });
  });
}
export async function configureTool(
  client: FerryClient,
  tool: SupportedTool,
  options: ToolOptions,
): Promise<number> {
  const selected = await connection(client, tool, options);
  const path = toolConfigPath(tool, homedir(), process.env);
  if (options.preview) {
    const safe = configuredContent(tool, selected).replaceAll(selected.secret, '[REDACTED]');
    process.stdout.write(
      options.json ? JSON.stringify({ tool, path, content: safe }) + '\n' : safe,
    );
    return 0;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error('ferry configure requires an interactive terminal; use --print to preview.');
  let existing = '';
  let exists = false;
  try {
    existing = await readFile(path, 'utf8');
    exists = true;
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT')
      throw error;
  }
  const content = configuredContent(tool, selected, existing);
  await mkdir(dirname(path), { recursive: true });
  let backup: string | null = null;
  if (exists) {
    backup = `${path}.backup-${String(Date.now())}`;
    await copyFile(path, backup);
  }
  await writeFile(path, content, { encoding: 'utf8', mode: 0o600 });
  process.stdout.write(
    options.json
      ? JSON.stringify({ tool, path, backup }) + '\n'
      : `Configured ${tool}: ${path}${backup ? ` (backup: ${backup})` : ''}\n`,
  );
  return 0;
}
