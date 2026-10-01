import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type FakeCliName = 'codex' | 'opencode' | 'claude';
export interface FakeCliOptions {
  targetDir?: string;
  finalText?: string;
  events?: unknown[];
  delayBeforeEventsMs?: number;
  holdOpenMs?: number;
  captureArgsPath?: string;
  captureCwdPath?: string;
  readyMarkerPath?: string;
  processIdPath?: string;
  versions?: Partial<Record<FakeCliName, string>>;
}
function stream(name: FakeCliName, finalText: string): unknown[] {
  const session = `fake-${name}-session-001`;
  if (name === 'codex')
    return [
      { type: 'thread.started', thread_id: session },
      { type: 'turn.started' },
      { type: 'item.started', item: { type: 'command_execution', command: 'node test.js' } },
      { type: 'item.completed', item: { type: 'command_execution', exit_code: 1 } },
      {
        type: 'turn.completed',
        usage: { input_tokens: 100, output_tokens: 24, cached_input_tokens: 0 },
      },
      {
        type: 'response_item',
        item: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: finalText }],
        },
      },
    ];
  if (name === 'opencode')
    return [
      { type: 'session', sessionID: session },
      { type: 'step-start', part: { id: 'step_fake' } },
      {
        type: 'tool',
        part: {
          id: 'call_fake',
          callID: 'call_fake',
          tool: 'bash',
          state: { status: 'running', input: { command: 'node test.js' } },
        },
      },
      {
        type: 'tool',
        part: {
          id: 'call_fake',
          callID: 'call_fake',
          tool: 'bash',
          state: {
            status: 'completed',
            input: { command: 'node test.js' },
            output: 'failed as expected',
          },
        },
      },
      { type: 'step-finish', reason: 'stop', tokens: { input: 100, output: 24 } },
      { type: 'text', part: { text: finalText } },
    ];
  return [
    { type: 'system', subtype: 'init', session_id: session },
    {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Inspecting repository' }] },
      usage: { input_tokens: 100, output_tokens: 5 },
    },
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'toolu_fake', name: 'Bash', input: { command: 'node test.js' } },
        ],
      },
    },
    {
      type: 'result',
      subtype: 'success',
      result: finalText,
      session_id: session,
      usage: { input_tokens: 120, output_tokens: 24 },
    },
  ];
}

export async function installFakeClis(
  binDir: string,
  options: FakeCliOptions = {},
): Promise<Record<FakeCliName, string>> {
  await mkdir(binDir, { recursive: true });
  const paths = {} as Record<FakeCliName, string>;
  for (const name of ['codex', 'opencode', 'claude'] as const) {
    const scriptPath = join(binDir, `${name}-fake.mjs`);
    const events = JSON.stringify(
      options.events ?? stream(name, options.finalText ?? 'Fake delegate completed.'),
    );
    const script = `${process.platform === 'win32' ? '' : '#!/usr/bin/env node\n'}import { appendFile, writeFile } from 'node:fs/promises';\nimport { resolve, join } from 'node:path';\nconst args = process.argv.slice(2);\nif (${JSON.stringify(options.processIdPath ?? '')}) await writeFile(${JSON.stringify(options.processIdPath ?? '')}, String(process.pid));\nif (${JSON.stringify(options.readyMarkerPath ?? '')}) await writeFile(${JSON.stringify(options.readyMarkerPath ?? '')}, 'ready');\nlet stdin = '';\nif (!args.includes('--version') && !['login','auth'].includes(args[0])) for await (const chunk of process.stdin) stdin += chunk;\nconst target = process.env.FAKE_CLI_TARGET ?? ${JSON.stringify(options.targetDir ?? '')};\nif (${JSON.stringify(options.captureCwdPath ?? '')}) await writeFile(${JSON.stringify(options.captureCwdPath ?? '')}, process.cwd());\nif (target) { await appendFile(join(resolve(target), 'FAKE_CLI_TOUCHED.txt'), ${JSON.stringify(`${name} executed\n`)}); }\nif (${JSON.stringify(options.captureArgsPath ?? '')}) await writeFile(${JSON.stringify(options.captureArgsPath ?? '')}, JSON.stringify([...args, ...(stdin ? [stdin] : [])]));\nif (args.includes('--version')) { process.stdout.write(${JSON.stringify(options.versions?.[name] ?? `${name} fake 1.0`)}); process.exit(0); }\nif (['login','auth'].includes(args[0])) { process.stdout.write('Logged in'); process.exit(0); }\nawait new Promise(resolve => setTimeout(resolve, ${String(options.delayBeforeEventsMs ?? 0)}));\nconst events = ${events};\nfor (const event of events) process.stdout.write(JSON.stringify(event) + '\\n');\nawait new Promise(resolve => setTimeout(resolve, ${String(options.holdOpenMs ?? 0)}));\n`;
    await writeFile(scriptPath, script, 'utf8');
    if (process.platform === 'win32') {
      const shim = join(binDir, `${name}.cmd`);
      await writeFile(shim, `@echo off\r\nnode "%~dp0\\${name}-fake.mjs" %*\r\n`, 'utf8');
      paths[name] = shim;
    } else {
      const launcher = join(binDir, name);
      await writeFile(
        launcher,
        `#!/bin/sh\nexec node "$(dirname "$0")/${name}-fake.mjs" "$@"\n`,
        'utf8',
      );
      await chmod(launcher, 0o755);
      paths[name] = launcher;
    }
  }
  return paths;
}

export function recordedCliEvents(name: FakeCliName, finalText?: string): unknown[] {
  return stream(name, finalText ?? 'Fake delegate completed.');
}
