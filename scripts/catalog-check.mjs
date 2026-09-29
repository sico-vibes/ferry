import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = new URL('..', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
const dataDir = join(root, 'packages', 'catalog', 'data');
const { parse } = createRequire(join(root, 'packages', 'catalog', 'package.json'))('yaml');
const today = new Date();
const staleDays = 30;
const sourceText = await readFile(join(dataDir, 'vendor', 'SOURCES.md'), 'utf8');
const sourceDate = /snapshot\s+(\d{4}-\d{2}-\d{2})/i.exec(sourceText)?.[1];
const datasets = [...sourceText.matchAll(/^\|\s*([^|]+?)\s*\|/gm)]
  .slice(1)
  .map((match) => match[1]?.split(',').map((name) => name.trim()) ?? [])
  .flat()
  .filter((name) => name && !/^[- ]+$/.test(name));
const dataAge = sourceDate
  ? Math.floor((today.getTime() - Date.parse(`${sourceDate}T00:00:00Z`)) / 86_400_000)
  : Number.POSITIVE_INFINITY;
console.log(`Vendored datasets (${sourceDate ?? 'date missing'}; ${dataAge} days old):`);
for (const dataset of datasets) console.log(`  ${dataset}${dataAge > staleDays ? ' [STALE]' : ''}`);

const providerFiles = await import('node:fs/promises').then(({ readdir }) =>
  readdir(join(dataDir, 'limits')),
);
const limits = await Promise.all(
  providerFiles
    .filter((file) => file.endsWith('.yaml'))
    .map(async (file) => parse(await readFile(join(dataDir, 'limits', file), 'utf8'))),
);
const snapshot = JSON.parse(await readFile(join(dataDir, 'models.snapshot.json'), 'utf8'));
const chain = parse(
  await readFile(join(root, 'packages', 'router', 'data', 'auto-free-chain.yaml'), 'utf8'),
);
const snapshotByProvider = new Map();
for (const [provider, entry] of Object.entries(snapshot)) {
  const providerId = provider === 'google' ? 'gemini' : provider;
  snapshotByProvider.set(
    providerId,
    Object.keys(entry.models ?? {}).map((id) => id.toLowerCase()),
  );
}
const toRegex = (glob) => {
  const pattern = [...glob]
    .map((character) => {
      if (character === '*') return '.*';
      if (character === '?') return '.';
      return '\\^$.*+()[]{}|'.includes(character) ? `\\${character}` : character;
    })
    .join('');
  return new RegExp(`^${pattern}$`, 'i');
};
const autoFreePatterns = Object.entries(chain.providers ?? {}).flatMap(([provider, patterns]) =>
  patterns.map((pattern) => ({ provider, pattern: toRegex(pattern) })),
);
const keyNames = (provider) => [
  `${provider.replace(/[^a-z0-9]/gi, '_').toUpperCase()}_API_KEY`,
  ...(provider === 'gemini' ? ['GOOGLE_API_KEY'] : []),
];
const endpoints = {
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  groq: 'https://api.groq.com/openai/v1',
  nvidia: 'https://integrate.api.nvidia.com/v1',
  mistral: 'https://api.mistral.ai/v1',
  sambanova: 'https://api.sambanova.ai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  kilo: 'https://api.kilo.ai/api/gateway',
  cerebras: 'https://api.cerebras.ai/v1',
  deepseek: 'https://api.deepseek.com/v1',
  huggingface: 'https://router.huggingface.co/v1',
  together: 'https://api.together.xyz/v1',
  fireworks: 'https://api.fireworks.ai/inference/v1',
  deepinfra: 'https://api.deepinfra.com/v1/openai',
  nebius: 'https://api.studio.nebius.com/v1',
  novita: 'https://api.novita.ai/v3/openai',
  hyperbolic: 'https://api.hyperbolic.xyz/v1',
  scaleway: 'https://api.scaleway.ai/v1',
  stepfun: 'https://api.stepfun.ai/v1',
  'zai-glm': 'https://api.z.ai/api/paas/v4',
  'vercel-ai-gateway': 'https://ai-gateway.vercel.sh/v1',
  opencode: 'https://opencode.ai/zen/v1',
  'opencode-go': 'https://opencode.ai/zen/go/v1',
  llm7: 'https://api.llm7.io/v1',
  tokenrouter: 'https://api.tokenrouter.com/v1',
  anyapi: 'https://api.anyapi.ai/v1',
  ovhcloud: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1',
};
const live = new Map();
const configured = new Set();
for (const provider of limits.filter((item) => !item.dead)) {
  const keyName = keyNames(provider.provider).find((name) => process.env[name]);
  if (!keyName) continue;
  configured.add(provider.provider);
  const endpoint = endpoints[provider.provider];
  if (!endpoint) {
    console.log(`SKIP ${provider.provider}: no standard model-list endpoint`);
    continue;
  }
  try {
    const response = await fetch(`${endpoint}/models`, {
      headers: { authorization: `Bearer ${process.env[keyName]}` },
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const ids = Array.isArray(payload.data)
      ? payload.data.flatMap((item) => {
          if (typeof item?.id !== 'string') return [];
          const id = item.id.toLowerCase().replace(/^models\//, '');
          return [provider.provider === 'nvidia' ? id.replace(/^nvidia\//, '') : id];
        })
      : [];
    live.set(provider.provider, ids);
  } catch (error) {
    console.log(`WARN ${provider.provider}: live list failed (${String(error).split('\n')[0]})`);
  }
}

let removedAutoFree = false;
let changes = 0;
console.log(`Live provider comparison (${configured.size} configured; absent keys skipped):`);
for (const [provider, ids] of live) {
  const snapshotIds = snapshotByProvider.get(provider) ?? [];
  const current = new Set(ids);
  const old = new Set(snapshotIds);
  const removed = snapshotIds.filter((id) => !current.has(id));
  const added = ids.filter((id) => !old.has(id));
  if (removed.length === 1 && added.length === 1) {
    console.log(`  POSSIBLE RENAME ${provider}/${removed[0]} -> ${provider}/${added[0]}`);
  }
  for (const id of removed) {
    changes += 1;
    console.log(`  REMOVED ${provider}/${id}`);
  }
  for (const id of added) {
    changes += 1;
    console.log(`  NEW ${provider}/${id}`);
  }
  for (const entry of autoFreePatterns) {
    if (entry.provider !== provider) continue;
    const matches = snapshotIds.filter((id) => entry.pattern.test(id));
    if (matches.length > 0 && !ids.some((id) => entry.pattern.test(id))) removedAutoFree = true;
  }
  if (removed.length === 0 && added.length === 0) console.log(`  ${provider}: unchanged`);
}
if (live.size === 0)
  console.log('  No live model lists checked. Configure PROVIDER_API_KEY values to enable checks.');
if (removedAutoFree)
  console.error('ERROR: a model pattern in the default Auto-Free chain has no live offering.');
console.log(
  `Catalog check complete: ${changes} live model changes; data stale=${dataAge > staleDays}.`,
);
if (removedAutoFree) process.exitCode = 1;
