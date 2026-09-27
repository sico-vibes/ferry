import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  buildCapabilityRegistry,
  loadFreeCodingRanking,
  loadCapabilityRegistry,
  loadQualityPriors,
  matchLeaderboardModel,
  normalizeModelId,
  rankFreeCodingModels,
  QUALITY_MODEL_ALIASES,
  resolveQualityFamily,
} from '../src/index.js';

const dataDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');

describe('capability registry', () => {
  it('normalizes provider aliases and free-tier suffixes to one canonical id', () => {
    expect(normalizeModelId('openai/gpt-oss-120b')).toBe('gpt-oss-120b');
    expect(normalizeModelId('qwen/qwen3.8-27b:free')).toBe('qwen3.8-27b');
  });

  it('preserves unknown tool support as null rather than negative evidence', () => {
    const capability = buildCapabilityRegistry([{ provider: 'custom', id: 'unlisted-coder' }])[
      'custom/unlisted-coder'
    ];
    expect(capability?.toolCall).toBeNull();
  });

  it('merges provider aliases and honors live, override, models.dev, Aider, then LiteLLM', () => {
    const registry = buildCapabilityRegistry([
      {
        provider: 'openrouter',
        id: 'openai/gpt-oss-120b:free',
        live: { tool_call: false, context: 64_000 },
        override: { tool_call: true, edit_format: 'udiff', tool_protocol: 'xml' },
        modelsDev: { tool_call: false, reasoning: true, context: 32_000, output: 4_000 },
        aider: { edit_format: 'whole' },
        litellm: { max_input_tokens: 8_000 },
      },
      {
        provider: 'groq',
        id: 'gpt-oss-120b',
        modelsDev: { vision: true, parallel_tool_calls: true },
      },
    ]);
    const byProvider = registry['openrouter/openai/gpt-oss-120b:free'];
    const alias = registry['openai/gpt-oss-120b'];
    expect(byProvider).toBe(alias);
    expect(byProvider).toMatchObject({
      toolCall: false,
      context: 64_000,
      reasoning: true,
      vision: true,
      parallelToolCalls: true,
      editFormat: 'udiff',
      toolProtocol: 'xml',
      provenance: { toolCall: 'live discovery', editFormat: 'Ferry override' },
    });
  });
});

describe('quality prior', () => {
  it('uses explicit mappings for ambiguous benchmark labels and rejects unknown names', () => {
    expect(matchLeaderboardModel('Gemini-3-Pro-Preview (Prompt)', ['gemini-3-pro-preview'])).toBe(
      'gemini-3-pro-preview',
    );
    expect(matchLeaderboardModel('qwen/qwen3.8-27b:free', ['Qwen/Qwen3.8-27B'])).toBe(
      'Qwen/Qwen3.8-27B',
    );
    expect(matchLeaderboardModel('unlisted proprietary model', ['qwen3-32b'])).toBeNull();
    expect(QUALITY_MODEL_ALIASES['gpt-oss-20b']).toBe('openai/gpt-oss-20b');
    expect(QUALITY_MODEL_ALIASES['codestral-latest']).toBe('mistral/codestral-latest');
    expect(resolveQualityFamily('gemini-3.8-flash')).toBe('gemini-flash');
  });

  it('shrinks missing evidence to a low-confidence baseline and penalizes tiny preview variants', () => {
    const ranked = rankFreeCodingModels(
      [
        { providerId: 'groq', id: 'qwen3.8-27b', name: 'Qwen 3.8 27B', family: 'qwen' },
        { providerId: 'groq', id: 'gemini-3.8-flash-1.5b-preview', name: 'Gemini preview 1.5B' },
      ],
      {},
    );
    expect(ranked[0]).toMatchObject({ score: 0.35, confidence: 0.1, penalty: 0 });
    expect(ranked[1]).toMatchObject({ score: 0.25, confidence: 0.1, penalty: 0.1 });
  });

  it('omits safety-filtered and no-longer-live models from free coding rankings', () => {
    const ranked = rankFreeCodingModels(
      [
        { providerId: 'groq', id: 'qwen3.8-27b', name: 'Qwen 3.8 27B' },
        { providerId: 'groq', id: 'gpt-oss-safeguard-20b', name: 'GPT-OSS Safeguard 20B' },
        { providerId: 'groq', id: 'qwen3-coder-32b-guard', name: 'Qwen Coder Guard' },
        { providerId: 'groq', id: 'old-coder-32b', name: 'Old Coder 32B', live: false },
      ],
      {},
    );
    expect(ranked.map(({ id }) => id)).toEqual(['qwen3.8-27b']);
  });

  it('limits the free ranking to an explicitly supplied live model set', async () => {
    const [priors, capabilities] = await Promise.all([
      loadQualityPriors(dataDir),
      loadCapabilityRegistry(dataDir),
    ]);
    const ranked = await loadFreeCodingRanking(dataDir, capabilities, priors, 15, [
      'groq/qwen/qwen3.8-27b',
    ]);
    expect(ranked.map(({ providerId, id }) => `${providerId}/${id}`)).toEqual([
      'groq/qwen/qwen3.8-27b',
    ]);
  });

  it('keeps missing benchmark evidence unknown and snapshots the top 15 free coding models', async () => {
    const [priors, capabilities, snapshot] = await Promise.all([
      loadQualityPriors(dataDir),
      loadCapabilityRegistry(dataDir),
      readFile(join(dataDir, 'quality-top15.snapshot.json'), 'utf8'),
    ]);
    const ranked = await loadFreeCodingRanking(dataDir, capabilities, priors, 15);
    expect(priors['model-with-no-evidence']).toBeUndefined();
    expect(Object.keys(priors).some((key) => key.startsWith('family:'))).toBe(true);
    expect(Object.keys(capabilities).length).toBeGreaterThan(0);
    expect(
      ranked.map(({ providerId, id, score, confidence, sources, datasetDate, rankingPenalty }) => ({
        id: `${providerId}/${id}`,
        score,
        confidence,
        sources,
        datasetDate,
        rankingPenalty,
      })),
    ).toEqual(JSON.parse(snapshot));
  });
});
