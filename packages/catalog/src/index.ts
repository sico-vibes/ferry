import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { resolveFerryRuntimePaths } from '@ferry/shared/electron-paths';
import { loadCapabilityRegistry, normalizeModelId } from './registry.js';
import { loadQualityPriors, qualityPenaltyForModel, resolveQualityFamily } from './quality.js';
import {
  ModelInfoSchema,
  isModelFreeForPlan,
  ProviderIdSchema,
  ModelRefSchema,
  ProviderTagSchema,
  TierSchema,
  type ModelInfo,
  type Tier,
  LogicalModelMappingSchema,
  ProviderRequestOverridesSchema,
  type LogicalModelMapping,
  type ProviderRequestOverrides,
} from '@ferry/shared';
import { z } from 'zod';

const WindowSchema = z.object({
  scope: z.enum(['provider', 'model']),
  model: z.string().optional(),
  metric: z.enum(['requests', 'tokens', 'usd', 'credits']),
  kind: z.enum([
    'rolling',
    'fixed_daily',
    'weekly_fixed',
    'weekly_from_first_use',
    'monthly_from_anchor',
    'dynamic_5h',
  ]),
  tz: z.string().optional(),
  time: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .optional(),
  dow: z.number().int().min(0).max(6).optional(),
  day: z.number().int().min(1).max(31).optional(),
  length: z.number().positive().optional(),
  limit: z.number().nonnegative().nullable(),
});
export const ProviderLimitsSchema = z.object({
  provider: z.string().min(1),
  name: z.string().min(1),
  tag: ProviderTagSchema,
  signup_url: z.url().nullable(),
  docs_url: z.url().nullable(),
  terms_note: z.string(),
  data_use: z.string(),
  data_use_training: z.boolean().nullable().optional(),
  verified_at: z.iso.date(),
  source_url: z.url(),
  parser: z.string().nullable().optional(),
  endpoints: z.array(z.url()).optional(),
  models_endpoint: z.literal('/models').optional(),
  required_headers: z.array(z.string().min(1)).optional(),
  probe_models: z.array(z.string().min(1)).optional(),
  key_required: z.boolean().optional(),
  free_plan: z
    .object({
      source_url: z.url(),
      models: z.array(z.string().min(1)),
      excluded_models: z.array(z.string().min(1)).optional(),
    })
    .optional(),
  cached_input_ratio: z.number().nonnegative().max(1).optional(),
  optional: z.boolean().optional(),
  dead: z.boolean().optional(),
  windows: z.array(WindowSchema),
});
export type ProviderLimits = z.infer<typeof ProviderLimitsSchema>;
export const TierCatalogSchema = z.record(
  z.string(),
  z.object({ tier: TierSchema, tool_reliability_prior: z.number().min(0).max(1) }),
);
export type TierCatalog = z.infer<typeof TierCatalogSchema>;
export const CatalogSchema = z.object({
  models: z.array(ModelInfoSchema),
  providers: z.array(ProviderLimitsSchema),
  tiers: TierCatalogSchema,
  capabilities: z.record(z.string(), z.unknown()).optional(),
  qualityPriors: z.record(z.string(), z.unknown()).optional(),
  logicalModels: z.array(LogicalModelMappingSchema).optional(),
  providerOverrides: z.record(z.string(), ProviderRequestOverridesSchema).optional(),
});

export {
  buildCapabilityRegistry,
  loadCapabilityRegistry,
  normalizeCapability,
  normalizeModelId,
} from './registry.js';
export {
  loadFreeCodingRanking,
  loadQualityPriors,
  isSafetyFilteredModel,
  matchLeaderboardModel,
  QUALITY_FAMILY_ALIASES,
  QUALITY_MODEL_ALIASES,
  qualityPenaltyForModel,
  rankFreeCodingModels,
  resolveQualityFamily,
} from './quality.js';
export type { CapabilityRegistry, LiveModelDiscovery, ModelCapability } from './registry.js';
export type { QualityPrior } from './quality.js';
export type Catalog = z.infer<typeof CatalogSchema>;

interface SnapshotModel {
  id: string;
  name?: string;
  family?: string;
  tool_call?: boolean;
  reasoning?: boolean;
  limit?: { context?: number; output?: number };
  cost?: { input?: number; output?: number; cache_read?: number };
  description?: string;
  release_date?: string;
  knowledge?: string;
  open_weights?: boolean;
  modalities?: { input?: string[] };
}
interface SnapshotProvider {
  name?: string;
  models?: Record<string, SnapshotModel>;
}
type Snapshot = Record<string, SnapshotProvider>;

export function normalizeModels(
  snapshot: unknown,
  tiers: TierCatalog = {},
  providerPlans: readonly Pick<ProviderLimits, 'provider' | 'tag' | 'free_plan'>[] = [],
): ModelInfo[] {
  const result: ModelInfo[] = [];
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) return result;
  for (const [snapshotProviderId, provider] of Object.entries(snapshot as Snapshot)) {
    const providerId = snapshotProviderId === 'google' ? 'gemini' : snapshotProviderId;
    for (const model of Object.values(provider.models ?? {})) {
      const ref = `${providerId}/${model.id}`;
      const tierInfo = tiers[ref] ?? tiers[model.id];
      const plan = providerPlans.find((providerPlan) => providerPlan.provider === providerId);
      const normalized = ModelInfoSchema.safeParse({
        ref,
        providerId,
        name: model.name ?? model.id,
        ...(model.family ? { family: model.family } : {}),
        tier: tierInfo?.tier ?? 'T2',
        contextWindow: model.limit?.context ?? 8192,
        maxOutput: model.limit?.output ?? Math.min(model.limit?.context ?? 8192, 4096),
        toolCalling: model.tool_call ?? false,
        reasoning: model.reasoning ?? false,
        free: isModelFreeForPlan(
          {
            id: ProviderIdSchema.parse(providerId),
            tag: plan?.tag ?? (providerId === 'kilo' ? 'promo' : 'legit'),
            ...(plan?.free_plan === undefined
              ? {}
              : {
                  freePlan: {
                    sourceUrl: plan.free_plan.source_url,
                    models: plan.free_plan.models,
                    ...(plan.free_plan.excluded_models === undefined
                      ? {}
                      : { excludedModels: plan.free_plan.excluded_models }),
                  },
                }),
          },
          {
            ref: ModelRefSchema.parse(ref),
            providerId: ProviderIdSchema.parse(providerId),
            free: model.cost?.input === 0 && model.cost.output === 0,
            priceInPerM: model.cost?.input ?? null,
            priceOutPerM: model.cost?.output ?? null,
          },
          plan?.tag === 'trial' ? [providerId] : [],
        ),
        priceInPerM: model.cost?.input ?? null,
        priceOutPerM: model.cost?.output ?? null,
        ...(model.cost?.cache_read === undefined
          ? {}
          : { priceCachedInPerM: model.cost.cache_read }),
        cachedInputRatio: 1,
        ...(model.description ? { description: model.description } : {}),
        ...(model.release_date ? { releaseDate: model.release_date } : {}),
        ...(model.knowledge ? { knowledgeCutoff: model.knowledge } : {}),
        ...(typeof model.open_weights === 'boolean' ? { openWeights: model.open_weights } : {}),
        ...(model.modalities?.input ? { inputModalities: model.modalities.input } : {}),
      });
      if (normalized.success) result.push(normalized.data);
    }
  }
  return result;
}

export async function loadCatalog(
  options: {
    tierOverrides?: Record<string, { tier?: Tier; tool_reliability_prior?: number }>;
    liveModels?: import('./registry.js').LiveModelDiscovery[];
    includeDead?: boolean;
    now?: Date;
  } = {},
): Promise<Catalog & { warnings: string[] }> {
  const runtimePaths = resolveFerryRuntimePaths({
    entryFilePath: fileURLToPath(import.meta.url),
    execPath: process.execPath,
    env: process.env,
    resourcesPath: (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath,
    exists: existsSync,
  });
  const data = runtimePaths.catalogDataDirectory;
  const [snapshotText, tierText, files] = await Promise.all([
    readFile(join(data, 'models.snapshot.json'), 'utf8'),
    readFile(join(data, 'tiers.yaml'), 'utf8'),
    readdir(join(data, 'limits')),
  ]);
  const [logicalModelsText, providerOverridesText] = await Promise.all([
    readFile(join(data, 'logical-models.json'), 'utf8'),
    readFile(join(data, 'provider-overrides.json'), 'utf8'),
  ]);
  const [capabilities, qualityPriors] = await Promise.all([
    loadCapabilityRegistry(data, options.liveModels),
    loadQualityPriors(data),
  ]);
  const tiers = TierCatalogSchema.parse(parse(tierText));
  for (const [model, override] of Object.entries(options.tierOverrides ?? {})) {
    const old = tiers[model];
    tiers[model] = {
      tier: override.tier ?? old?.tier ?? 'T2',
      tool_reliability_prior: override.tool_reliability_prior ?? old?.tool_reliability_prior ?? 0.5,
    };
  }
  const providers = (
    await Promise.all(
      files
        .filter((file) => file.endsWith('.yaml'))
        .map(async (file) =>
          ProviderLimitsSchema.parse(parse(await readFile(join(data, 'limits', file), 'utf8'))),
        ),
    )
  ).filter((provider) => (options.includeDead ?? false) || !provider.dead);
  const now = options.now ?? new Date();
  const warnings = providers
    .filter(
      (provider) => now.getTime() - Date.parse(`${provider.verified_at}T00:00:00Z`) > 60 * 86400000,
    )
    .map((provider) => `Provider limits for ${provider.provider} are older than 60 days.`);
  const models = normalizeModels(JSON.parse(snapshotText), tiers, providers).map((model) => {
    const providerCacheRatio = providers.find(
      (provider) => provider.provider === model.providerId,
    )?.cached_input_ratio;
    const capability =
      capabilities[model.ref] ?? capabilities[model.ref.slice(model.ref.indexOf('/') + 1)];
    const bareId = model.ref.slice(model.ref.indexOf('/') + 1);
    const quality =
      qualityPriors[model.ref] ??
      qualityPriors[bareId] ??
      qualityPriors[
        `family:${normalizeModelId(resolveQualityFamily(bareId, model.family ?? undefined) ?? '')}`
      ];
    const score = quality?.score ?? 0.35;
    const confidence = quality?.confidence ?? 0.1;
    return {
      ...model,
      cachedInputRatio: providerCacheRatio ?? model.cachedInputRatio ?? 1,
      toolCalling: capability?.toolCall ?? true,
      ...(capability ? { capability } : {}),
      quality: score,
      qualityConfidence: confidence,
      qualityPenalty: qualityPenaltyForModel(`${model.name} ${bareId}`, confidence),
      qualitySources:
        quality?.sources.map((source) => {
          const date = source.startsWith('Aider') ? quality.aiderDate : quality.bfclDate;
          return date ? `${source} (${date})` : source;
        }) ?? [],
      qualityDate: quality?.datasetDate ?? null,
    };
  });
  return CatalogSchema.extend({ warnings: z.array(z.string()) }).parse({
    models,
    providers,
    tiers,
    capabilities,
    qualityPriors,
    logicalModels: z.array(LogicalModelMappingSchema).parse(JSON.parse(logicalModelsText)),
    providerOverrides: z
      .record(z.string(), ProviderRequestOverridesSchema)
      .parse(JSON.parse(providerOverridesText)),
    warnings,
  });
}

export type { LogicalModelMapping, ProviderRequestOverrides };
