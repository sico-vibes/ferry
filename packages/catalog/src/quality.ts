import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { normalizeModelId } from './registry.js';

export const QUALITY_MODEL_ALIASES: Record<string, string> = {
  'gpt-oss-120b': 'openai/gpt-oss-120b',
  'gpt-oss-20b': 'openai/gpt-oss-20b',
  'openai/gpt-oss-120b': 'openai/gpt-oss-120b',
  'gemini-flash-latest': 'google/gemini-flash-latest',
  'gemini-flash-lite-latest': 'google/gemini-flash-lite-latest',
  'gemini-2.5-flash': 'google/gemini-2.5-flash',
  'gemini-2.5-flash-lite': 'google/gemini-2.5-flash-lite',
  'codestral-latest': 'mistral/codestral-latest',
  'devstral-latest': 'mistral/devstral-latest',
  'deepseek-v4-flash': 'deepseek/deepseek-v4-flash',
  'glm-5.3-flash': 'z-ai/glm-5.3-flash',
  'nemotron-3-super-120b-a12b': 'nvidia/nemotron-3-super-120b-a12b',
  'gemma-4-31b-it': 'google/gemma-4-31b-it',
  'llama-3.3-70b-instruct': 'meta-llama/llama-3.3-70b-instruct',
  'llama-4-scout': 'meta-llama/llama-4-scout',
  'qwen3.8-27b': 'qwen/qwen3.8-27b',
  'qwen3-coder-480b-a35b-instruct': 'qwen/qwen3-coder-480b-a35b-instruct',
  'qwen3-32b-fc': 'qwen/qwen3-32b',
  'qwen3-32b-prompt': 'qwen/qwen3-32b',
  'claude-opus-4-5-20251101-fc': 'anthropic/claude-opus-4-5',
  'claude-sonnet-4-5-20250929-fc': 'anthropic/claude-sonnet-4-5',
  'gemini-3-pro-preview-prompt': 'google/gemini-3-pro-preview',
  'gemini-2-0-pro-exp-02-05': 'google/gemini-2.0-pro',
  'deepseek-r1': 'deepseek/deepseek-r1',
};

export const QUALITY_FAMILY_ALIASES: Record<string, string> = {
  'gpt-oss-120b': 'gpt-oss',
  'gpt-oss-20b': 'gpt-oss',
  'gemini-flash-latest': 'gemini-flash',
  'gemini-3.8-flash': 'gemini-flash',
  'gemini-3.7-flash': 'gemini-flash',
  'gemini-3.5-flash': 'gemini-flash',
  'gemini-2.5-flash': 'gemini-flash',
  'gemini-flash-lite-latest': 'gemini-flash-lite',
  'gemini-2.5-flash-lite': 'gemini-flash-lite',
  'codestral-latest': 'codestral',
  'devstral-latest': 'devstral',
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4.1-flash': 'deepseek-flash',
  'glm-5.3-flash': 'glm-flash',
  'nemotron-3-nano-30b-a3b': 'nemotron',
  'nemotron-3-super-120b-a12b': 'nemotron',
  'gemma-4-26b-a4b-it': 'gemma',
  'gemma-4-31b-it': 'gemma',
  'llama-3.3-70b-instruct': 'llama',
  'llama-4-scout': 'llama',
  'llama-4-maverick': 'llama',
  'qwen3.8-27b': 'qwen3',
  'qwen3-coder-480b-a35b-instruct': 'qwen3',
};

const modelIndexes = new WeakMap<
  readonly string[],
  {
    exact: Map<string, string>;
    tokens: Map<string, string[]>;
  }
>();

function indexModels(catalogIds: readonly string[]) {
  const cached = modelIndexes.get(catalogIds);
  if (cached) return cached;
  const exact = new Map<string, string>();
  const tokens = new Map<string, string[]>();
  for (const id of catalogIds) {
    const normalized = normalizeModelId(id);
    exact.set(normalized, id);
    for (const token of normalized.split(/[-._]+/).filter((part) => part.length > 1)) {
      const bucket = tokens.get(token) ?? [];
      bucket.push(id);
      tokens.set(token, bucket);
    }
  }
  const index = { exact, tokens };
  modelIndexes.set(catalogIds, index);
  return index;
}

export interface QualityPrior {
  score: number;
  confidence: number;
  aiderCoding: number | null;
  wellFormed: number | null;
  bfclOverall: number | null;
  bfclLive: number | null;
  datasetDate: string | null;
  aiderDate: string | null;
  bfclDate: string | null;
  sources: string[];
}

export interface FreeModelCandidate {
  providerId: string;
  id: string;
  name: string;
  family?: string;
  toolCall?: boolean | null;
  live?: boolean;
}

export interface RankedFreeModel extends FreeModelCandidate {
  score: number;
  confidence: number;
  penalty: number;
  rankingPenalty: number;
  sources: string[];
  datasetDate: string | null;
}

const qualityBaseline = 0.35;
const unmeasuredConfidence = 0.1;
const freeProviderSources: Record<string, string> = {
  gemini: 'google',
  groq: 'groq',
  cerebras: 'cerebras',
  mistral: 'mistral',
  sambanova: 'sambanova',
  nvidia: 'nvidia',
  'cloudflare-workers-ai': 'cloudflare-workers-ai',
  kilo: 'kilo',
};

export function resolveQualityFamily(modelId: string, family?: string): string | null {
  const normalized = normalizeModelId(modelId);
  const alias = QUALITY_FAMILY_ALIASES[normalized];
  if (alias) return alias;
  if (normalized.includes('gpt-oss-20b') || normalized.includes('gpt-oss-120b')) return 'gpt-oss';
  if (normalized.includes('gemini') && normalized.includes('flash-lite'))
    return 'gemini-flash-lite';
  if (normalized.includes('gemini') && normalized.includes('flash')) return 'gemini-flash';
  if (normalized.includes('codestral')) return 'codestral';
  if (normalized.includes('devstral')) return 'devstral';
  if (normalized.includes('deepseek') && normalized.includes('v4') && normalized.includes('flash'))
    return 'deepseek-flash';
  if (normalized.includes('glm-5') && normalized.includes('flash')) return 'glm-flash';
  if (normalized.includes('glm-5')) return 'glm';
  if (normalized.includes('nemotron-3')) return 'nemotron';
  if (normalized.includes('gemma-4')) return 'gemma';
  if (normalized.includes('llama-3.3') || normalized.includes('llama-4')) return 'llama';
  if (normalized.includes('qwen3')) return 'qwen3';
  return family?.toLowerCase() ?? null;
}

function codingFamily(modelId: string, family?: string): boolean {
  const resolved = resolveQualityFamily(modelId, family);
  return Boolean(
    resolved &&
    [
      'gpt-oss',
      'qwen',
      'qwen3',
      'gemini-flash',
      'gemini-flash-lite',
      'codestral',
      'devstral',
      'deepseek-flash',
      'glm',
      'glm-flash',
      'nemotron',
      'gemma',
      'llama',
    ].includes(resolved),
  );
}

export function qualityPenaltyForModel(modelId: string, confidence: number): number {
  if (confidence >= 0.5) return 0;
  const normalized = normalizeModelId(modelId);
  const tiny = /(?:^|[-/])(?:\d+(?:\.\d+)?b)(?:[-/]|$)/.exec(normalized);
  const parameters = tiny?.[0].match(/\d+(?:\.\d+)?/)?.[0];
  const underTenB = parameters !== undefined && Number(parameters) < 10;
  const tunedOrSmall = /(?:-fin(?:-|$)|-sante(?:-|$)|nano|mini|preview|stealth)/.test(normalized);
  return underTenB || tunedOrSmall ? 0.1 : 0;
}

export function rankFreeCodingModels(
  candidates: readonly FreeModelCandidate[],
  priors: Record<string, QualityPrior>,
  limit = 15,
): RankedFreeModel[] {
  const familyCounts = new Map<string, number>();
  const ranked = candidates
    .filter(
      (candidate) =>
        candidate.live !== false &&
        !isSafetyFilteredModel(`${candidate.name} ${candidate.id}`) &&
        candidate.toolCall !== false &&
        codingFamily(candidate.id, candidate.family),
    )
    .map((candidate) => {
      const family = resolveQualityFamily(candidate.id, candidate.family);
      const evidence =
        priors[normalizeModelId(candidate.id)] ??
        priors[normalizeModelId(`${candidate.providerId}/${candidate.id}`)] ??
        (family ? priors[`family:${normalizeModelId(family)}`] : undefined);
      const confidence =
        typeof evidence?.confidence === 'number' && Number.isFinite(evidence.confidence)
          ? Math.min(1, Math.max(0, evidence.confidence))
          : unmeasuredConfidence;
      const qualityScore =
        typeof evidence?.score === 'number' && Number.isFinite(evidence.score)
          ? Math.min(1, Math.max(0, evidence.score))
          : qualityBaseline;
      const penalty = qualityPenaltyForModel(`${candidate.name} ${candidate.id}`, confidence);
      const familyKey = family ?? normalizeModelId(candidate.id);
      const priorModelsInFamily = familyCounts.get(familyKey) ?? 0;
      familyCounts.set(familyKey, priorModelsInFamily + 1);
      const rankingPenalty = priorModelsInFamily * 0.08;
      return {
        ...candidate,
        score: Math.max(0, qualityScore - penalty - rankingPenalty),
        confidence,
        penalty,
        rankingPenalty,
        sources: evidence?.sources ?? [],
        datasetDate: evidence?.datasetDate ?? null,
      };
    })
    .map((candidate) => ({ ...candidate, score: Number(candidate.score.toFixed(4)) }))
    .toSorted((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  return ranked.slice(0, limit);
}
export function isSafetyFilteredModel(modelId: string): boolean {
  return /safeguard|(?:^|[-/])guard(?:[-/]|$)/i.test(modelId);
}
interface LeaderboardRow {
  model?: string;
  command?: string;
  pass_rate_2?: number;
  percent_cases_well_formed?: number;
  date?: string;
}
export function matchLeaderboardModel(name: string, catalogIds: readonly string[]): string | null {
  const index = indexModels(catalogIds);
  const cleaned = name
    .toLowerCase()
    .replace(/\s*\((fc|prompt|thinking)\)/gi, '')
    .replace(/:free\b/gi, '')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9./_-]/g, '');
  const explicit =
    QUALITY_MODEL_ALIASES[cleaned] ?? QUALITY_MODEL_ALIASES[normalizeModelId(cleaned)];
  if (explicit) return index.exact.get(normalizeModelId(explicit)) ?? explicit;
  const needle = normalizeModelId(cleaned);
  const exact = index.exact.get(needle);
  if (exact) return exact;
  const tokens = needle.split(/[-._]+/).filter((token) => token.length > 1);
  const possible = new Set(tokens.flatMap((token) => index.tokens.get(token) ?? []));
  let winner: string | null = null;
  let best = 0;
  for (const id of possible) {
    const candidate = normalizeModelId(id);
    const matched = tokens.filter((token) => candidate.includes(token)).length;
    const score = matched / Math.max(tokens.length, candidate.split(/[-._]+/).length);
    if (score > best) {
      best = score;
      winner = id;
    }
  }
  return best >= 0.72 ? winner : null;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index] ?? '';
    if (char === '"' && quoted && text[index + 1] === '"') {
      field += '"';
      index++;
    } else if (char === '"') quoted = !quoted;
    else if (char === ',' && !quoted) {
      row.push(field);
      field = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[index + 1] === '\n') index++;
      row.push(field);
      if (row.some(Boolean)) rows.push(row);
      row = [];
      field = '';
    } else field += char;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
function percent(value: unknown): number | null {
  const number =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseFloat(value.replace('%', ''))
        : NaN;
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number / 100)) : null;
}
function put(
  priors: Record<string, QualityPrior>,
  id: string,
  key: keyof Pick<QualityPrior, 'aiderCoding' | 'wellFormed' | 'bfclOverall' | 'bfclLive'>,
  value: number,
  date: string | null,
  source: string,
) {
  const prior = priors[id] ?? {
    score: qualityBaseline,
    confidence: unmeasuredConfidence,
    aiderCoding: null,
    wellFormed: null,
    bfclOverall: null,
    bfclLive: null,
    datasetDate: date,
    aiderDate: null,
    bfclDate: null,
    sources: [],
  };
  const previousDate = source === 'Aider Polyglot' ? prior.aiderDate : prior.bfclDate;
  if (date && previousDate && date < previousDate) return;
  prior[key] = value;
  if (source === 'Aider Polyglot') prior.aiderDate = date;
  else prior.bfclDate = date;
  prior.datasetDate =
    [prior.datasetDate, date]
      .filter((part): part is string => Boolean(part))
      .sort()
      .at(-1) ?? null;
  if (!prior.sources.includes(source)) prior.sources.push(source);
  const signals = [prior.aiderCoding, prior.wellFormed, prior.bfclOverall, prior.bfclLive].filter(
    (part): part is number => part !== null,
  );
  const rawScore = signals.reduce((sum, part) => sum + part, 0) / signals.length;
  prior.confidence = Math.min(0.95, signals.length * 0.2);
  prior.score = qualityBaseline + (rawScore - qualityBaseline) * prior.confidence;
  priors[id] = prior;
}

export async function loadQualityPriors(dataDir: string): Promise<Record<string, QualityPrior>> {
  const vendor = join(dataDir, 'vendor');
  const [aiderText, overallText, liveText, sourcesText] = await Promise.all([
    readFile(join(vendor, 'aider-polyglot-leaderboard.yml'), 'utf8'),
    readFile(join(vendor, 'bfcl-data_overall.csv'), 'utf8'),
    readFile(join(vendor, 'bfcl-data_live.csv'), 'utf8'),
    readFile(join(vendor, 'SOURCES.md'), 'utf8'),
  ]);
  const modelData = JSON.parse(
    await readFile(join(vendor, 'models.dev.api.json'), 'utf8'),
  ) as Record<string, { models?: Record<string, unknown> }>;
  const allModels = Object.values(modelData).flatMap((provider) =>
    Object.keys(provider.models ?? {}),
  );
  const dateMatch = /snapshot\s+(\d{4}-\d{2}-\d{2})/i.exec(sourcesText);
  const date = dateMatch?.[1] ?? null;
  const ids = [...new Set(allModels)];
  const priors: Record<string, QualityPrior> = {};
  const aider = parse(aiderText) as LeaderboardRow[];
  for (const row of aider) {
    const id = matchLeaderboardModel(row.model ?? row.command?.split(/\s+/).at(-1) ?? '', ids);
    const coding = percent(row.pass_rate_2);
    const wellFormed = percent(row.percent_cases_well_formed);
    if (!id || coding === null) continue;
    put(priors, id, 'aiderCoding', coding, row.date ?? null, 'Aider Polyglot');
    if (wellFormed !== null)
      put(priors, id, 'wellFormed', wellFormed, row.date ?? null, 'Aider Polyglot');
  }
  for (const [text, key, source] of [
    [overallText, 'bfclOverall', 'BFCL overall'],
    [liveText, 'bfclLive', 'BFCL live'],
  ] as const) {
    const [header = [], ...rows] = parseCsv(text);
    const modelIndex = header.findIndex((column) => column.toLowerCase() === 'model');
    const scoreIndex = header.findIndex((column) => column.toLowerCase().includes('overall acc'));
    for (const row of rows) {
      const id = matchLeaderboardModel(row[modelIndex] ?? '', ids);
      const score = percent(row[scoreIndex]);
      if (id && score !== null) put(priors, id, key, score, date, source);
    }
  }
  const families = new Map<string, string>();
  for (const provider of Object.values(modelData)) {
    for (const [id, model] of Object.entries(provider.models ?? {})) {
      const family = (model as { family?: unknown }).family;
      const resolved = resolveQualityFamily(id, typeof family === 'string' ? family : undefined);
      if (resolved) families.set(normalizeModelId(id), normalizeModelId(resolved));
    }
  }
  const familyCounts = new Map<
    string,
    Partial<Record<'aiderCoding' | 'wellFormed' | 'bfclOverall' | 'bfclLive', number>>
  >();
  const familyModels = new Map<string, Set<string>>();
  for (const [id, prior] of Object.entries(priors)) {
    const family = families.get(normalizeModelId(id));
    if (!family) continue;
    const key = `family:${family}`;
    const familyPrior = priors[key] ?? {
      score: qualityBaseline,
      confidence: unmeasuredConfidence,
      aiderCoding: null,
      wellFormed: null,
      bfclOverall: null,
      bfclLive: null,
      datasetDate: prior.datasetDate,
      aiderDate: prior.aiderDate,
      bfclDate: prior.bfclDate,
      sources: [],
    };
    const counts = familyCounts.get(key) ?? {};
    const members = familyModels.get(key) ?? new Set<string>();
    members.add(id);
    for (const metric of ['aiderCoding', 'wellFormed', 'bfclOverall', 'bfclLive'] as const) {
      const metricValue = prior[metric];
      if (metricValue === null) continue;
      const count = (counts[metric] ?? 0) + 1;
      const oldAverage = familyPrior[metric] ?? 0;
      familyPrior[metric] = oldAverage + (metricValue - oldAverage) / count;
      counts[metric] = count;
    }
    familyPrior.aiderDate ??= prior.aiderDate;
    familyPrior.bfclDate ??= prior.bfclDate;
    familyPrior.datasetDate =
      [familyPrior.aiderDate, familyPrior.bfclDate]
        .filter((part): part is string => Boolean(part))
        .sort()
        .at(-1) ?? null;
    familyPrior.sources = [...new Set([...familyPrior.sources, ...prior.sources])];
    const values = [
      familyPrior.aiderCoding,
      familyPrior.wellFormed,
      familyPrior.bfclOverall,
      familyPrior.bfclLive,
    ].filter((part): part is number => part !== null);
    const rawScore = values.reduce((sum, part) => sum + part, 0) / values.length;
    familyPrior.confidence = Math.min(0.95, values.length * 0.2 + (members.size - 1) * 0.025);
    familyPrior.score = qualityBaseline + (rawScore - qualityBaseline) * familyPrior.confidence;
    priors[key] = familyPrior;
    familyCounts.set(key, counts);
    familyModels.set(key, members);
  }
  return priors;
}

export async function loadFreeCodingRanking(
  dataDir: string,
  capabilities: Record<string, { toolCall: boolean | null }>,
  priors: Record<string, QualityPrior>,
  limit = 15,
  liveModelRefs?: readonly string[],
): Promise<RankedFreeModel[]> {
  const vendor = join(dataDir, 'vendor');
  const [modelsText, openRouterText] = await Promise.all([
    readFile(join(vendor, 'models.dev.api.json'), 'utf8'),
    readFile(join(vendor, 'openrouter-models.json'), 'utf8'),
  ]);
  const modelData = JSON.parse(modelsText) as Record<
    string,
    {
      models?: Record<
        string,
        { name?: string; family?: string; cost?: { input?: number; output?: number } }
      >;
    }
  >;
  const candidates: FreeModelCandidate[] = [];
  const liveRefs = liveModelRefs ? new Set(liveModelRefs.map((ref) => ref.toLowerCase())) : null;
  for (const [providerId, dataProvider] of Object.entries(freeProviderSources)) {
    for (const [id, model] of Object.entries(modelData[dataProvider]?.models ?? {})) {
      if (
        liveRefs &&
        !liveRefs.has(`${providerId}/${id}`.toLowerCase()) &&
        !liveRefs.has(`${dataProvider}/${id}`.toLowerCase())
      )
        continue;
      if (
        providerId === 'kilo' &&
        !(model.cost?.input === 0 && model.cost.output === 0) &&
        !/:free(?:$|:)/i.test(id)
      )
        continue;
      const toolCall = capabilities[`${dataProvider}/${id}`]?.toolCall;
      candidates.push({
        providerId,
        id,
        name: model.name ?? id,
        ...(model.family ? { family: model.family } : {}),
        ...(toolCall !== undefined ? { toolCall } : {}),
      });
    }
  }
  const openRouter = JSON.parse(openRouterText) as {
    data?: {
      id: string;
      name?: string;
      pricing?: { prompt?: string; completion?: string };
    }[];
  };
  for (const model of openRouter.data ?? []) {
    if (liveRefs && !liveRefs.has(`openrouter/${model.id}`.toLowerCase())) continue;
    const free =
      model.id.endsWith(':free') ||
      (Number(model.pricing?.prompt) === 0 && Number(model.pricing?.completion) === 0);
    if (!free) continue;
    const toolCall = capabilities[`openrouter/${model.id}`]?.toolCall;
    candidates.push({
      providerId: 'openrouter',
      id: model.id,
      name: model.name ?? model.id,
      ...(toolCall !== undefined ? { toolCall } : {}),
    });
  }
  return rankFreeCodingModels(candidates, priors, limit);
}
