import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type FakeCliName = 'codex' | 'opencode' | 'claude';
export interface FakeCliOptions {
  targetDir?: string;
  finalText?: string;
  events?: unknown[];
  delayBeforeEventsMs?: number;
  holdOpenMs?: number;
  captureArgsPath?: string;
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
        callID: 'call_fake',
        tool: 'bash',
        state: {
          status: 'completed',
          input: { command: 'node test.js' },
          output: 'failed as expected',
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
    const script = `import { appendFile, writeFile } from 'node:fs/promises';\nimport { resolve, join } from 'node:path';\nconst args = process.argv.slice(2);\nlet stdin = '';\nif (!args.includes('--version') && !['login','auth'].includes(args[0])) for await (const chunk of process.stdin) stdin += chunk;\nconst target = process.env.FAKE_CLI_TARGET ?? ${JSON.stringify(options.targetDir ?? '')};\nif (target) { await appendFile(join(resolve(target), 'FAKE_CLI_TOUCHED.txt'), ${JSON.stringify(`${name} executed\n`)}); }\nif (${JSON.stringify(options.captureArgsPath ?? '')}) await writeFile(${JSON.stringify(options.captureArgsPath ?? '')}, JSON.stringify([...args, ...(stdin ? [stdin] : [])]));\nif (args.includes('--version')) { process.stdout.write(${JSON.stringify(`${name} fake 1.0`)}); process.exit(0); }\nif (['login','auth'].includes(args[0])) { process.stdout.write('Logged in'); process.exit(0); }\nawait new Promise(resolve => setTimeout(resolve, ${String(options.delayBeforeEventsMs ?? 0)}));\nconst events = ${events};\nfor (const event of events) process.stdout.write(JSON.stringify(event) + '\\n');\nawait new Promise(resolve => setTimeout(resolve, ${String(options.holdOpenMs ?? 0)}));\n`;
    await writeFile(scriptPath, script, 'utf8');
    const shim = join(binDir, `${name}.cmd`);
    await writeFile(shim, `@echo off\r\nnode "%~dp0\\${name}-fake.mjs" %*\r\n`, 'utf8');
    paths[name] = shim;
  }
  return paths;
}

export function recordedCliEvents(name: FakeCliName, finalText?: string): unknown[] {
  return stream(name, finalText ?? 'Fake delegate completed.');
}
