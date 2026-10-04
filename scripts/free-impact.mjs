import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dataDir = join(root, 'packages', 'catalog', 'data');
const output = join(root, '.dev', 'runs', 'free-impact.md');
const { parse } = createRequire(join(root, 'packages', 'catalog', 'package.json'))('yaml');
const [snapshot, limitFiles] = await Promise.all([
  readFile(join(dataDir, 'models.snapshot.json'), 'utf8').then(JSON.parse),
  import('node:fs/promises').then(({ readdir }) => readdir(join(dataDir, 'limits'))),
]);
const providers = await Promise.all(
  limitFiles
    .filter((file) => file.endsWith('.yaml'))
    .map(async (file) => parse(await readFile(join(dataDir, 'limits', file), 'utf8'))),
);
const plans = new Map(providers.map((provider) => [provider.provider, provider]));
const excludedFromAutoFree = (provider) =>
  provider.tag === 'paid' || provider.tag === 'credits' || provider.provider === 'opencode';
const exactZero = (model) => model.cost?.input === 0 && model.cost?.output === 0;
const nonzeroPrice = (model) =>
  [model.cost?.input, model.cost?.output].some((price) => price != null && price !== 0);
const modelIdOf = (provider, ref) => ref.slice(provider.provider.length + 1);
const globRegex = (glob) => {
  const escaped = [...glob]
    .map((char) =>
      char === '*' ? '.*' : char === '?' ? '.' : char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&'),
    )
    .join('');
  return new RegExp(`^${escaped}$`, 'i');
};
const planCovers = (provider, ref) => {
  const plan = provider.free_plan;
  if (!plan) return false;
  const modelId = modelIdOf(provider, ref);
  return (
    plan.models.some((pattern) => globRegex(pattern).test(modelId)) &&
    !(plan.excluded_models ?? []).some((pattern) => globRegex(pattern).test(modelId))
  );
};
const excludedByPlan = (provider, ref) => {
  const modelId = modelIdOf(provider, ref);
  return (provider.free_plan?.excluded_models ?? []).find((pattern) =>
    globRegex(pattern).test(modelId),
  );
};

function wasFreeForRouting(provider, model, ref) {
  const freeFlag = (model.cost?.input ?? 0) === 0 && (model.cost?.output ?? 0) === 0;
  if (provider.tag === 'trial') return false;
  if (provider.provider === 'openrouter') return /:free(?:$|:)/i.test(ref);
  if (provider.provider === 'kilo') return /:free(?:$|:)/i.test(ref) || exactZero(model);
  if (provider.key_required === false) return true;
  if (excludedFromAutoFree(provider)) return false;
  if (provider.tag === 'subscription_cli' || provider.tag === 'subscription_oauth')
    return freeFlag || exactZero(model);
  if (provider.tag === 'legit' || provider.tag === 'promo') return true;
  return freeFlag;
}

function isFreeNow(provider, model, ref) {
  const zeroPriced = exactZero(model);
  if (provider.provider === 'openrouter') return /:free(?:$|:)/i.test(ref) || zeroPriced;
  if (provider.dead || excludedFromAutoFree(provider) || provider.tag === 'trial') return false;
  if (provider.free_plan && planCovers(provider, ref)) return true;
  if (nonzeroPrice(model)) return false;
  return zeroPriced;
}

const rows = [];
const flips = [];
for (const [sourceProvider, entry] of Object.entries(snapshot)) {
  const providerId = sourceProvider === 'google' ? 'gemini' : sourceProvider;
  const provider = plans.get(providerId) ?? {
    provider: providerId,
    tag: 'paid',
    key_required: true,
  };
  let beforeCount = 0;
  let afterCount = 0;
  for (const [id, model] of Object.entries(entry.models ?? {})) {
    const ref = `${providerId}/${id}`;
    const before = !excludedFromAutoFree(provider) && wasFreeForRouting(provider, model, ref);
    const after = isFreeNow(provider, model, ref);
    if (before) beforeCount += 1;
    if (after) afterCount += 1;
    if (before !== after) {
      const reason = after
        ? provider.provider === 'openrouter'
          ? /:free(?:$|:)/i.test(ref)
            ? 'OpenRouter explicitly defines the :free variant; it does not bill account credits.'
            : 'OpenRouter catalog input/output prices are both $0.'
          : provider.free_plan && planCovers(provider, ref)
            ? `Covered by sourced free-tier plan (${provider.free_plan.source_url}); free-tier billing selected.`
            : 'Catalog input/output prices are both known and $0.'
        : provider.dead
          ? `Provider free plan does not provide API access (${provider.free_plan?.source_url ?? provider.source_url}).`
          : excludedFromAutoFree(provider)
            ? `Auto-Free retains the blanket ${provider.tag} provider rejection.`
            : provider.free_plan && !planCovers(provider, ref)
              ? `Outside sourced free-plan coverage${excludedByPlan(provider, ref) ? `; excluded by pattern ${excludedByPlan(provider, ref)}` : ''} (${provider.free_plan.source_url}).`
              : nonzeroPrice(model)
                ? 'At least one catalog price is nonzero.'
                : provider.provider === 'openrouter' && /:free(?:$|:)/i.test(ref)
                  ? 'OpenRouter :free variant contradicts missing or nonzero catalog price.'
                  : provider.provider === 'openrouter'
                    ? 'OpenRouter free routing requires a known $0/$0 catalog price.'
                    : 'Catalog prices are unknown and no sourced provider free plan is declared.';
      flips.push({ provider: providerId, ref, before, after, reason });
    }
  }
  rows.push({
    provider: providerId,
    modelCount: Object.keys(entry.models ?? {}).length,
    beforeCount,
    afterCount,
  });
}
rows.sort((a, b) => a.provider.localeCompare(b.provider));
flips.sort((a, b) => a.provider.localeCompare(b.provider) || a.ref.localeCompare(b.ref));

const lines = [
  '# Free routing impact',
  '',
  'Generated from `packages/catalog/data/models.snapshot.json` and provider plans in `packages/catalog/data/limits/*.yaml`.',
  'Before reproduces `main` Auto-Free eligibility with default trial opt-ins (none). After assumes the user selected the provider free-tier billing setting and applies the sourced `free_plan` coverage, $0, OpenRouter, trial, and paid/credits policies in this worktree. Snapshot providers without a catalog limits entry are counted as non-routable.',
  '',
  '| Provider | Snapshot models | Free before | Free after |',
  '|---|---:|---:|---:|',
  ...rows.map(
    (row) => `| ${row.provider} | ${row.modelCount} | ${row.beforeCount} | ${row.afterCount} |`,
  ),
  '',
  `Total: ${rows.reduce((sum, row) => sum + row.beforeCount, 0)} free before; ${rows.reduce((sum, row) => sum + row.afterCount, 0)} free after; ${flips.length} status flips.`,
  '',
  '## Models whose status changed',
  '',
  ...(flips.length
    ? flips.map(
        (flip) =>
          `- \`${flip.ref}\`: ${flip.before ? 'free' : 'billable'} \u2192 ${flip.after ? 'free' : 'billable'}. ${flip.reason}`,
      )
    : ['No model statuses changed.']),
  '',
];
await mkdir(join(root, '.dev', 'runs'), { recursive: true });
await writeFile(output, lines.join('\n'), 'utf8');
console.log(`Wrote ${output} (${rows.length} providers; ${flips.length} flips).`);
