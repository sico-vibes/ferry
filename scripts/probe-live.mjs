import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runLiveProbe } from '../packages/providers/src/live-probe.ts';

const envText = await readFile(join(process.cwd(), '.env.local'), 'utf8');
const env = Object.fromEntries(
  envText.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) return [];
    const value = (match[2] ?? '').replace(/^(['"])(.*)\1$/, '$2');
    return [[match[1] ?? '', value]];
  }),
);
const keys = {
  opencode: env.OPENCODE_ZEN,
  openrouter: env.OPENROUTER,
  groq: env.GROQ,
  gemini: env.GEMINI,
  nvidia: env.NVIDIA,
  mistral: env.MISTRAL,
  cerebras: env.CEREBRAS,
};
const outputDirectory = join(process.cwd(), 'packages', 'testkit', 'fixtures', 'live');
console.log('provider\tok\tmodel\tskipped models (reason)\tparsed windows');
await runLiveProbe({ keys, outputDirectory, print: console.log });
