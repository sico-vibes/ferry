import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const vendor = join(root, 'packages', 'catalog', 'data', 'vendor');
const sources = {
  'models.dev.api.json': 'https://models.dev/api.json',
  'aider-model-settings.yml':
    'https://raw.githubusercontent.com/Aider-AI/aider/main/aider/resources/model-settings.yml',
  'aider-model-metadata.json':
    'https://raw.githubusercontent.com/Aider-AI/aider/main/aider/resources/model-metadata.json',
  'aider-polyglot-leaderboard.yml':
    'https://raw.githubusercontent.com/Aider-AI/aider/main/aider/website/_data/polyglot_leaderboard.yml',
  'aider-edit-leaderboard.yml':
    'https://raw.githubusercontent.com/Aider-AI/aider/main/aider/website/_data/edit_leaderboard.yml',
  'litellm-model-prices.json':
    'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json',
  'openrouter-models.json': 'https://openrouter.ai/api/v1/models',
  'bfcl-data_overall.csv':
    'https://raw.githubusercontent.com/ShishirPatil/gorilla/main/berkeley-function-call-leaderboard/data_overall.csv',
  'bfcl-data_live.csv':
    'https://raw.githubusercontent.com/ShishirPatil/gorilla/main/berkeley-function-call-leaderboard/data_live.csv',
};
await mkdir(vendor, { recursive: true });
for (const [file, url] of Object.entries(sources)) {
  const response = await fetch(url, { headers: { 'user-agent': 'Ferry-catalog-dataset-sync' } });
  if (!response.ok) throw new Error(`Download failed (${response.status}) for ${file}: ${url}`);
  await writeFile(join(vendor, file), Buffer.from(await response.arrayBuffer()));
  console.log(`Updated ${file}`);
}
const date = new Date().toISOString().slice(0, 10);
const licenseRows = [
  ['models.dev.api.json', 'https://models.dev/api.json (anomalyco/models.dev)', 'MIT'],
  [
    'aider-model-settings.yml, aider-model-metadata.json, aider-polyglot-leaderboard.yml, aider-edit-leaderboard.yml',
    'https://github.com/Aider-AI/aider',
    'Apache-2.0',
  ],
  [
    'litellm-model-prices.json',
    'https://github.com/BerriAI/litellm model_prices_and_context_window.json',
    'MIT',
  ],
  [
    'openrouter-models.json',
    'https://openrouter.ai/api/v1/models (live snapshot; metadata only)',
    'OpenRouter API terms - used as a dated snapshot',
  ],
  ['bfcl-*.csv', 'https://github.com/ShishirPatil/gorilla', 'Apache-2.0'],
];
const table = licenseRows
  .map(([file, source, license]) => `| ${file} | ${source} | ${license} |`)
  .join('\n');
const text = `# Vendored datasets (snapshot ${date})\n| File | Source | License |\n|---|---|---|\n${table}\nRefresh with \`pnpm catalog:sync-datasets\` (network; orchestrator runs it).\n`;
await writeFile(join(vendor, 'SOURCES.md'), text, 'utf8');
