import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runLiveProbe } from '../packages/providers/src/live-probe.ts';

const envText = await readFile(join(process.cwd(), '.env.local'), 'utf8').catch(() => '');
const env = Object.fromEntries(
  envText.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) return [];
    const value = (match[2] ?? '').replace(/^(['"])(.*)\1$/, '$2');
    return [[match[1] ?? '', value]];
  }),
);
const providers = [
  'OPENCODE_ZEN',
  'OPENROUTER',
  'GROQ',
  'GEMINI',
  'NVIDIA',
  'MISTRAL',
  'CEREBRAS',
  'SAMBANOVA',
  'LLM7',
  'CLOUDFLARE_WORKERS_AI',
  'KILO',
  'VERCEL_AI_GATEWAY',
  'HUGGINGFACE',
  'OVHCLOUD',
  'TOKENROUTER',
  'ANYAPI',
  'ZAI_GLM',
  'FIREWORKS',
  'NEBIUS',
  'SCALEWAY',
  'HYPERBOLIC',
  'DEEPINFRA',
  'NOVITA',
  'TOGETHER',
  'STEPFUN',
];
const keys = Object.fromEntries(
  providers.map((name) => [
    name.toLowerCase().replaceAll('_', '-').replace('opencode-zen', 'opencode'),
    env[`${name}_API_KEY`],
  ]),
);
keys['cloudflare-workers-ai'] = env.CLOUDFLARE_WORKERS_AI_API_KEY;
const baseUrls = env.CLOUDFLARE_ACCOUNT_ID
  ? {
      'cloudflare-workers-ai': `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}/ai/v1`,
    }
  : {};
const secrets = providers.map((name) => env[`${name}_API_KEY`]).filter(Boolean);
const outputDirectory = join(process.cwd(), 'packages', 'testkit', 'fixtures', 'live');
console.log('provider\tok\tmodel\tskipped models (reason)\tparsed windows');
await runLiveProbe({
  keys,
  baseUrls,
  outputDirectory,
  print: (line) =>
    console.log(secrets.reduce((safe, secret) => safe.replaceAll(secret, '[REDACTED]'), line)),
});
