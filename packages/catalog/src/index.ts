import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
import {
  ModelInfoSchema,
  ProviderTagSchema,
  TierSchema,
  type ModelInfo,
  type Tier,
} from '@ferry/shared';
import { z } from 'zod';

const here = dirname(fileURLToPath(import.meta.url));
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
  verified_at: z.iso.date(),
  source_url: z.url(),
  parser: z.string().nullable().optional(),
  endpoints: z.array(z.url()).optional(),
  required_headers: z.array(z.string().min(1)).optional(),
  probe_models: z.array(z.string().min(1)).optional(),
  key_required: z.boolean().optional(),
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
});
export type Catalog = z.infer<typeof CatalogSchema>;

interface SnapshotModel {
  id: string;
  name?: string;
  tool_call?: boolean;
  reasoning?: boolean;
  limit?: { context?: number; output?: number };
  cost?: { input?: number; output?: number };
}
interface SnapshotProvider {
  name?: string;
  models?: Record<string, SnapshotModel>;
}
type Snapshot = Record<string, SnapshotProvider>;

export function normalizeModels(snapshot: unknown, tiers: TierCatalog = {}): ModelInfo[] {
  const result: ModelInfo[] = [];
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) return result;
  for (const [snapshotProviderId, provider] of Object.entries(snapshot as Snapshot)) {
    const providerId = snapshotProviderId === 'google' ? 'gemini' : snapshotProviderId;
    for (const model of Object.values(provider.models ?? {})) {
      const ref = `${providerId}/${model.id}`;
      const tierInfo = tiers[ref] ?? tiers[model.id];
      const normalized = ModelInfoSchema.safeParse({
        ref,
        providerId,
        name: model.name ?? model.id,
        tier: tierInfo?.tier ?? 'T2',
        contextWindow: model.limit?.context ?? 8192,
        maxOutput: model.limit?.output ?? Math.min(model.limit?.context ?? 8192, 4096),
        toolCalling: model.tool_call ?? false,
        reasoning: model.reasoning ?? false,
        free: (model.cost?.input ?? 0) === 0 && (model.cost?.output ?? 0) === 0,
        priceInPerM: model.cost?.input ?? null,
        priceOutPerM: model.cost?.output ?? null,
      });
      if (normalized.success) result.push(normalized.data);
    }
  }
  return result;
}

export async function loadCatalog(
  options: {
    tierOverrides?: Record<string, { tier?: Tier; tool_reliability_prior?: number }>;
    includeDead?: boolean;
    now?: Date;
  } = {},
): Promise<Catalog & { warnings: string[] }> {
  const data = join(here, '..', 'data');
  const [snapshotText, tierText, files] = await Promise.all([
    readFile(join(data, 'models.snapshot.json'), 'utf8'),
    readFile(join(data, 'tiers.yaml'), 'utf8'),
    readdir(join(data, 'limits')),
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
  const models = normalizeModels(JSON.parse(snapshotText), tiers);
  return CatalogSchema.extend({ warnings: z.array(z.string()) }).parse({
    models,
    providers,
    tiers,
    warnings,
  });
}
