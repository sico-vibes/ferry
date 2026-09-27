import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';

export type ToolProtocol = 'native' | 'xml' | 'react' | 'none';
export interface ModelCapability {
  modelId: string;
  aliases: string[];
  toolCall: boolean | null;
  parallelToolCalls: boolean | null;
  vision: boolean;
  reasoning: boolean;
  context: number;
  maxOutput: number;
  editFormat: string;
  toolProtocol: ToolProtocol;
  cachePrompt: boolean | null;
  temperature: boolean | null;
  sources: string[];
  provenance: Record<string, string>;
}
export type CapabilityRegistry = Record<string, ModelCapability>;
export interface CapabilityInput {
  provider: string;
  id: string;
  family?: string;
  live?: Record<string, unknown>;
  override?: Record<string, unknown>;
  modelsDev?: Record<string, unknown>;
  openrouter?: Record<string, unknown>;
  aider?: Record<string, unknown>;
  litellm?: Record<string, unknown>;
}
export interface LiveModelDiscovery {
  provider: string;
  id: string;
  supported_parameters?: string[];
  [key: string]: unknown;
}

export function normalizeModelId(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/:free$/i, '')
    .replace(/^[^/]+\//, '')
    .replace(/[^a-z0-9._-]+/g, '-');
}

const fieldAliases: Record<string, string[]> = {
  toolCall: ['tool_call', 'supports_function_calling', 'supports_tool_calling'],
  parallelToolCalls: ['parallel_tool_calls', 'supports_parallel_function_calling'],
  vision: ['vision', 'supports_vision', 'attachment'],
  reasoning: ['reasoning', 'supports_reasoning'],
  context: ['context', 'max_input_tokens', 'max_tokens'],
  maxOutput: ['output', 'max_output_tokens', 'max_completion_tokens'],
  editFormat: ['edit_format'],
  toolProtocol: ['tool_protocol'],
  cachePrompt: ['cachePrompt', 'supports_prompt_caching', 'cache_read'],
  temperature: ['temperature', 'supports_temperature', 'use_temperature'],
};
const sourceProperties = [
  'live',
  'override',
  'modelsDev',
  'openrouter',
  'aider',
  'litellm',
] as const;
const sourceNames: Record<(typeof sourceProperties)[number], string> = {
  live: 'live discovery',
  override: 'Ferry override',
  modelsDev: 'models.dev',
  openrouter: 'OpenRouter snapshot',
  aider: 'Aider',
  litellm: 'LiteLLM',
};
function sourceLabel(index: number): string {
  const property = sourceProperties[index];
  return property ? sourceNames[property] : 'unknown';
}
function mergeSource(
  group: CapabilityInput[],
  source: 'live' | 'override' | 'modelsDev' | 'openrouter' | 'aider' | 'litellm',
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const entry of group) {
    const value = entry[source];
    if (value) Object.assign(merged, value);
  }
  return merged;
}
function valueFor(source: Record<string, unknown> | undefined, names: string[]): unknown {
  if (!source) return undefined;
  for (const name of names)
    if (source[name] !== undefined && source[name] !== null) return source[name];
  return undefined;
}
function booleanValue(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}
function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}
function boolField(input: CapabilityInput, field: string, fallback: boolean): [boolean, string] {
  for (let i = 0; i < sourceProperties.length; i++) {
    const sourceName = sourceProperties[i];
    const raw = sourceName
      ? valueFor(input[sourceName], fieldAliases[field] ?? [field])
      : undefined;
    const value = booleanValue(raw);
    if (value !== null) return [value, sourceLabel(i)];
  }
  return [fallback, 'family default'];
}
function numberField(input: CapabilityInput, field: string, fallback: number): [number, string] {
  for (let i = 0; i < sourceProperties.length; i++) {
    const sourceName = sourceProperties[i];
    const raw = sourceName
      ? valueFor(input[sourceName], fieldAliases[field] ?? [field])
      : undefined;
    const value = numberValue(raw);
    if (value !== null) return [value, sourceLabel(i)];
  }
  return [fallback, 'family default'];
}
function nullableBoolField(input: CapabilityInput, field: string): [boolean | null, string] {
  for (let i = 0; i < sourceProperties.length; i++) {
    const sourceName = sourceProperties[i];
    const value = booleanValue(
      sourceName ? valueFor(input[sourceName], fieldAliases[field] ?? [field]) : undefined,
    );
    if (value !== null) return [value, sourceLabel(i)];
  }
  return [null, 'unknown'];
}
function editFormat(input: CapabilityInput): [string, string] {
  for (let i = 0; i < sourceProperties.length; i++) {
    const sourceName = sourceProperties[i];
    const value = sourceName
      ? valueFor(input[sourceName], fieldAliases.editFormat ?? [])
      : undefined;
    if (typeof value === 'string') return [value, sourceLabel(i)];
  }
  const family = normalizeModelId(input.family ?? input.id);
  const format = /^(gpt-4|claude-3|claude-sonnet|claude-opus)/.test(family) ? 'diff' : 'whole';
  return [format, 'family default'];
}
function protocol(input: CapabilityInput, toolCall: boolean): [ToolProtocol, string] {
  for (let i = 0; i < sourceProperties.length; i++) {
    const sourceName = sourceProperties[i];
    const value = sourceName
      ? valueFor(input[sourceName], fieldAliases.toolProtocol ?? [])
      : undefined;
    if (value === 'native' || value === 'xml' || value === 'react' || value === 'none')
      return [value, sourceLabel(i)];
  }
  return [toolCall ? 'native' : 'none', 'family default'];
}

export function normalizeCapability(input: CapabilityInput): ModelCapability {
  const modelId = normalizeModelId(input.id);
  const [toolCall, toolSource] = nullableBoolField(input, 'toolCall');
  const [parallelToolCalls, parallelSource] = nullableBoolField(input, 'parallelToolCalls');
  const [vision, visionSource] = boolField(input, 'vision', false);
  const [reasoning, reasoningSource] = boolField(input, 'reasoning', false);
  const [context, contextSource] = numberField(input, 'context', 8192);
  const [maxOutput, outputSource] = numberField(input, 'maxOutput', Math.min(context, 4096));
  const [editFormatValue, editSource] = editFormat(input);
  const [toolProtocolValue, protocolSource] = protocol(input, toolCall === true);
  const [cachePrompt, cacheSource] = nullableBoolField(input, 'cachePrompt');
  const [temperature, temperatureSource] = nullableBoolField(input, 'temperature');
  const provenance = {
    toolCall: toolSource,
    parallelToolCalls: parallelSource,
    vision: visionSource,
    reasoning: reasoningSource,
    context: contextSource,
    maxOutput: outputSource,
    editFormat: editSource,
    toolProtocol: protocolSource,
    cachePrompt: cacheSource,
    temperature: temperatureSource,
  };
  return {
    modelId,
    aliases: [...new Set([input.id, `${input.provider}/${input.id}`, modelId])],
    toolCall,
    parallelToolCalls,
    vision,
    reasoning,
    context,
    maxOutput,
    editFormat: editFormatValue,
    toolProtocol: toolProtocolValue,
    cachePrompt,
    temperature,
    sources: [
      ...new Set(
        Object.values(provenance).filter(
          (source) => source !== 'unknown' && source !== 'family default',
        ),
      ),
    ],
    provenance,
  };
}

function recordsFromJson(
  json: unknown,
): { provider: string; id: string; model: Record<string, unknown> }[] {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return [];
  const records: { provider: string; id: string; model: Record<string, unknown> }[] = [];
  for (const [provider, raw] of Object.entries(json)) {
    if (!raw || typeof raw !== 'object') continue;
    const models = (raw as Record<string, unknown>).models;
    if (!models || typeof models !== 'object' || Array.isArray(models)) continue;
    for (const [id, model] of Object.entries(models))
      if (model && typeof model === 'object')
        records.push({ provider, id, model: model as Record<string, unknown> });
  }
  return records;
}

export function buildCapabilityRegistry(inputs: CapabilityInput[]): CapabilityRegistry {
  const registry: CapabilityRegistry = {};
  const grouped = new Map<string, CapabilityInput[]>();
  for (const input of inputs) {
    const normalizedId = normalizeModelId(input.id);
    const group = grouped.get(normalizedId) ?? [];
    group.push(input);
    grouped.set(normalizedId, group);
  }
  for (const [modelId, group] of grouped) {
    const unified: CapabilityInput = {
      provider: group[0]?.provider ?? '',
      id: group[0]?.id ?? modelId,
      ...(group[0]?.family ? { family: group[0].family } : {}),
      live: mergeSource(group, 'live'),
      override: mergeSource(group, 'override'),
      modelsDev: mergeSource(group, 'modelsDev'),
      openrouter: mergeSource(group, 'openrouter'),
      aider: mergeSource(group, 'aider'),
      litellm: mergeSource(group, 'litellm'),
    };
    const normalized = normalizeCapability(unified);
    const aliases = [
      ...new Set(
        group.flatMap((entry) => [
          entry.id,
          `${entry.provider}/${entry.id}`,
          entry.id.replace(/:free$/i, ''),
          `${entry.provider}/${entry.id.replace(/:free$/i, '')}`,
          normalizeModelId(entry.id),
          normalizeModelId(`${entry.provider}/${entry.id}`),
          modelId,
        ]),
      ),
    ];
    const capability = { ...normalized, aliases };
    for (const entry of group) registry[`${entry.provider}/${entry.id}`] = capability;
    for (const alias of aliases) registry[alias] = capability;
  }
  return registry;
}

export async function loadCapabilityRegistry(
  dataDir: string,
  liveModels: LiveModelDiscovery[] = [],
): Promise<CapabilityRegistry> {
  const [modelsText, aiderText, pricesText, settingsText, overridesText, openrouterText] =
    await Promise.all([
      readFile(join(dataDir, 'vendor', 'models.dev.api.json'), 'utf8'),
      readFile(join(dataDir, 'vendor', 'aider-model-metadata.json'), 'utf8'),
      readFile(join(dataDir, 'vendor', 'litellm-model-prices.json'), 'utf8'),
      readFile(join(dataDir, 'vendor', 'aider-model-settings.yml'), 'utf8'),
      readFile(join(dataDir, 'capability-overrides.yaml'), 'utf8').catch(() => '{}'),
      readFile(join(dataDir, 'vendor', 'openrouter-models.json'), 'utf8'),
    ]);
  const modelsDev = recordsFromJson(JSON.parse(modelsText));
  const aider = JSON.parse(
    aiderText.replace(/^\s*\/\/.*$/gm, '').replace(/,\s*([}\]])/g, '$1'),
  ) as Record<string, Record<string, unknown>>;
  const prices = JSON.parse(pricesText) as Record<string, Record<string, unknown>>;
  const settings = parse(settingsText, { uniqueKeys: false }) as Record<string, unknown>[];
  const overrides = parse(overridesText) as Record<string, Record<string, unknown>>;
  const openrouter = JSON.parse(openrouterText) as {
    data?: (Record<string, unknown> & { id?: string; supported_parameters?: string[] })[];
  };
  const aiderById = new Map(
    Object.entries(aider).map(([name, record]) => [normalizeModelId(name), record]),
  );
  const pricesById = new Map(
    Object.entries(prices).map(([name, record]) => [normalizeModelId(name), record]),
  );
  const settingsById = new Map(
    settings.flatMap((record) =>
      typeof record.name === 'string' ? [[normalizeModelId(record.name), record] as const] : [],
    ),
  );
  const candidates = new Map<string, CapabilityInput>();
  for (const { provider, id, model } of modelsDev) {
    const key = `${provider}/${id}`;
    const normalizedId = normalizeModelId(id);
    const aiderData = aiderById.get(normalizedId);
    const liteData = pricesById.get(normalizedId);
    const aiderSettings = settingsById.get(normalizedId);
    const normalizedModel = model;
    const inputModalities = (normalizedModel.modalities as { input?: string[] } | undefined)?.input;
    candidates.set(key, {
      provider,
      id,
      ...(typeof normalizedModel.family === 'string' ? { family: normalizedModel.family } : {}),
      modelsDev: {
        ...normalizedModel,
        context: (normalizedModel.limit as Record<string, unknown> | undefined)?.context,
        output: (normalizedModel.limit as Record<string, unknown> | undefined)?.output,
        vision: inputModalities ? inputModalities.includes('image') : normalizedModel.attachment,
      },
      aider: { ...(aiderData ?? {}), ...(aiderSettings ?? {}) },
      ...(liteData ? { litellm: liteData } : {}),
      ...((overrides[key] ?? overrides[id]) ? { override: overrides[key] ?? overrides[id] } : {}),
    });
  }
  for (const item of openrouter.data ?? []) {
    if (!item.id) continue;
    const parameters = item.supported_parameters ?? [];
    const architecture = item.architecture as { input_modalities?: string[] } | undefined;
    const topProvider = item.top_provider as { max_completion_tokens?: number } | undefined;
    const key = `openrouter/${item.id}`;
    const prior = candidates.get(key);
    const normalizedId = normalizeModelId(item.id);
    const liteData = pricesById.get(normalizedId);
    const openrouterFields: Record<string, unknown> = {};
    if (Array.isArray(item.supported_parameters)) {
      openrouterFields.tool_call = parameters.includes('tools');
      openrouterFields.parallel_tool_calls = parameters.includes('parallel_tool_calls');
      openrouterFields.reasoning = parameters.includes('reasoning');
      openrouterFields.cachePrompt = parameters.some((parameter) =>
        parameter.includes('prompt-caching'),
      );
    }
    if (typeof item.context_length === 'number') openrouterFields.context = item.context_length;
    if (typeof topProvider?.max_completion_tokens === 'number')
      openrouterFields.output = topProvider.max_completion_tokens;
    if (architecture?.input_modalities)
      openrouterFields.vision = architecture.input_modalities.includes('image');
    candidates.set(key, {
      ...(prior ?? { provider: 'openrouter', id: item.id }),
      id: item.id,
      openrouter: openrouterFields,
      ...((overrides[key] ?? overrides[item.id])
        ? { override: overrides[key] ?? overrides[item.id] }
        : {}),
      ...(aiderById.has(normalizedId) || settingsById.has(normalizedId)
        ? {
            aider: {
              ...(aiderById.get(normalizedId) ?? {}),
              ...(settingsById.get(normalizedId) ?? {}),
            },
          }
        : {}),
      ...(liteData ? { litellm: liteData } : {}),
    });
  }
  for (const item of liveModels) {
    const key = `${item.provider}/${item.id}`;
    const prior = candidates.get(key);
    const parameters = item.supported_parameters;
    const architecture = item.architecture as { input_modalities?: string[] } | undefined;
    const topProvider = item.top_provider as { max_completion_tokens?: number } | undefined;
    const live: Record<string, unknown> = { ...item };
    if (parameters) {
      live.tool_call = parameters.includes('tools');
      live.parallel_tool_calls = parameters.includes('parallel_tool_calls');
      live.reasoning = parameters.includes('reasoning');
      live.cachePrompt = parameters.some((parameter) => parameter.includes('prompt-caching'));
    } else {
      if (typeof item.tool_call === 'boolean') live.tool_call = item.tool_call;
      if (typeof item.toolCalling === 'boolean') live.tool_call = item.toolCalling;
    }
    if (architecture?.input_modalities)
      live.vision = architecture.input_modalities.includes('image');
    if (typeof item.context_length === 'number') live.context = item.context_length;
    if (typeof topProvider?.max_completion_tokens === 'number')
      live.output = topProvider.max_completion_tokens;
    candidates.set(key, {
      ...(prior ?? { provider: item.provider, id: item.id }),
      live,
    });
  }
  return buildCapabilityRegistry([...candidates.values()]);
}
