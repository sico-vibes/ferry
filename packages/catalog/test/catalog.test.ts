import { describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
import { ModelInfoSchema, ProviderTagSchema, TierSchema } from '@ferry/shared';
import {
  loadCatalog,
  normalizeModels,
  ProviderLimitsSchema,
  TierCatalogSchema,
} from '../src/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
describe('catalog data', () => {
  it('validates all limit and tier yaml', async () => {
    const names = await readdir(join(root, 'limits'));
    for (const name of names.filter((entry) => entry.endsWith('.yaml'))) {
      const text = await readFile(join(root, 'limits', name), 'utf8');
      expect(() => ProviderLimitsSchema.parse(parse(text)), name).not.toThrow();
    }
    const tierYaml = await readFile(join(root, 'tiers.yaml'), 'utf8');
    expect(() => TierCatalogSchema.parse(parse(tierYaml))).not.toThrow();
    expect(ProviderTagSchema.options).toContain('legit');
    expect(TierSchema.options).toContain('T1');
  });
  it('normalizes the snapshot and returns model schema-valid records', async () => {
    const catalog = await loadCatalog({ now: new Date('2026-09-24T00:00:00Z') });
    expect(catalog.models.length).toBeGreaterThan(100);
    expect(catalog.models.every((model) => ModelInfoSchema.safeParse(model).success)).toBe(true);
    expect(catalog.providers.some((provider) => provider.provider === 'openrouter')).toBe(true);
    expect(catalog.providers.some((provider) => provider.dead)).toBe(false);
    expect(
      (await loadCatalog({ includeDead: true })).providers.some((provider) => provider.dead),
    ).toBe(true);
  });
  it('supports user tier overrides', () => {
    const models = normalizeModels(
      {
        demo: {
          models: {
            chat: {
              id: 'chat',
              name: 'Demo',
              limit: { context: 10000, output: 2000 },
              tool_call: true,
              cost: { input: 1, output: 2 },
            },
          },
        },
      },
      { chat: { tier: 'T1', tool_reliability_prior: 0.99 } },
    );
    expect(models[0]?.tier).toBe('T1');
    expect(models[0]?.contextWindow).toBe(10000);
  });

  it('keeps every active provider discoverable through catalog models or probe hints', async () => {
    const catalog = await loadCatalog();
    for (const provider of catalog.providers) {
      const hasModel = catalog.models.some((model) => model.providerId === provider.provider);
      expect(
        provider.dead === true ||
          hasModel ||
          Boolean(provider.probe_models?.length) ||
          provider.key_required === false,
        provider.provider,
      ).toBe(true);
    }
  });
});
