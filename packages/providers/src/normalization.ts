import type { ModelMessage } from 'ai';
export type MessageNormalizationProvider =
  'anthropic' | 'openai' | 'mistral' | 'deepseek' | 'generic';
export function sanitizeProviderMessages(
  messages: readonly ModelMessage[],
  provider: MessageNormalizationProvider,
): ModelMessage[] {
  const clean = (value: string) =>
    Array.from(value, (character) => {
      const code = character.charCodeAt(0);
      return character.length === 1 && code >= 0xd800 && code <= 0xdfff ? '\uFFFD' : character;
    }).join('');
  const mistralIds = new Map<string, string>();
  const mistralReverse = new Map<string, string>();
  const normalizeMistralId = (value: string): string => {
    const original = clean(value);
    const known = mistralIds.get(original);
    if (known) return known;
    const simple = original.replace(/[^a-zA-Z0-9]/g, '');
    if (simple.length <= 9 || /[ /]/.test(original)) {
      const id = simple.slice(0, 9).padEnd(9, '0');
      if (mistralReverse.has(id) && mistralReverse.get(id) !== original) {
        const hashed = nextMistralHash(original, mistralReverse);
        mistralIds.set(original, hashed);
        mistralReverse.set(hashed, original);
        return hashed;
      }
      mistralIds.set(original, id);
      mistralReverse.set(id, original);
      return id;
    }
    const id = nextMistralHash(original, mistralReverse);
    mistralIds.set(original, id);
    mistralReverse.set(id, original);
    return id;
  };
  const cleanNestedStrings = (value: unknown): unknown => {
    if (typeof value === 'string') return clean(value);
    if (Array.isArray(value)) return value.map(cleanNestedStrings);
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [key, cleanNestedStrings(child)]),
      );
    return value;
  };
  const result: unknown[] = [];
  let needsAssistant = false;
  for (const message of messages) {
    const record = cleanNestedStrings(structuredClone(message)) as Record<string, unknown>;
    const role = record.role;
    let content = record.content;
    if (typeof content === 'string') content = clean(content);
    else if (Array.isArray(content)) {
      content = content
        .filter(
          (part) =>
            part &&
            typeof part === 'object' &&
            !(
              ['text', 'reasoning'].includes(String((part as Record<string, unknown>).type)) &&
              !((part as Record<string, unknown>).text as string | undefined)?.trim()
            ),
        )
        .map((part) => {
          const value = { ...(part as Record<string, unknown>) };
          if (typeof value.text === 'string') value.text = clean(value.text);
          if (typeof value.toolCallId === 'string')
            value.toolCallId =
              provider === 'mistral'
                ? normalizeMistralId(value.toolCallId)
                : provider === 'anthropic'
                  ? clean(value.toolCallId).replace(/[^a-zA-Z0-9_-]/g, '_')
                  : clean(value.toolCallId);
          if (provider === 'deepseek' && value.type === 'reasoning') {
            value.type = 'text';
          }
          return value;
        });
    }
    if (role === 'user' && provider === 'mistral' && needsAssistant) {
      result.push({ role: 'assistant', content: 'Done.' });
      needsAssistant = false;
    }
    if (
      typeof content === 'string'
        ? !content.trim()
        : Array.isArray(content)
          ? !content.length
          : false
    )
      continue;
    record.content = content;
    result.push(record);
    if (role === 'tool' && provider === 'mistral') needsAssistant = true;
    else if (role === 'assistant' && provider === 'mistral') needsAssistant = false;
  }
  return result as ModelMessage[];
}
export function normalizeToolSchema(schema: unknown, provider: string): unknown {
  const resolved = inlineLocalReferences(schema, schema, new Set());
  const keepDefinitions = containsReference(resolved);
  return normalizeSchemaNode(resolved, provider, keepDefinitions);
}
function normalizeSchemaNode(schema: unknown, provider: string, keepDefinitions: boolean): unknown {
  if (Array.isArray(schema))
    return schema.map((item) => normalizeSchemaNode(item, provider, keepDefinitions));
  if (!schema || typeof schema !== 'object') return schema;
  const input = schema as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (['$schema', 'examples'].includes(key)) continue;
    if (['$defs', 'definitions'].includes(key) && !keepDefinitions) continue;
    if (
      ['openai', 'mistral', 'deepseek'].includes(provider) &&
      ['additionalProperties', 'unevaluatedProperties', 'patternProperties'].includes(key)
    )
      continue;
    output[key] = normalizeSchemaNode(value, provider, keepDefinitions);
  }
  if (Array.isArray(output.oneOf)) {
    const variants = output.oneOf as Record<string, unknown>[];
    const constants = variants.map((item) => {
      const properties =
        item.properties && typeof item.properties === 'object'
          ? (item.properties as Record<string, unknown>)
          : undefined;
      const typed =
        properties?.type && typeof properties.type === 'object'
          ? (properties.type as Record<string, unknown>).const
          : undefined;
      return item.const ?? typed;
    });
    if (constants.every((value) => typeof value === 'string')) {
      output.enum = constants;
      delete output.oneOf;
    }
  }
  return output;
}
function inlineLocalReferences(value: unknown, root: unknown, seen: Set<string>): unknown {
  if (Array.isArray(value)) return value.map((item) => inlineLocalReferences(item, root, seen));
  if (!value || typeof value !== 'object') return value;
  const input = value as Record<string, unknown>;
  if (typeof input.$ref === 'string' && input.$ref.startsWith('#/')) {
    const target = resolveJsonPointer(root, input.$ref);
    if (target !== undefined && typeof target === 'object' && !seen.has(input.$ref)) {
      const nextSeen = new Set(seen).add(input.$ref);
      const siblings = Object.fromEntries(Object.entries(input).filter(([key]) => key !== '$ref'));
      return inlineLocalReferences(
        { ...(target as Record<string, unknown>), ...siblings },
        root,
        nextSeen,
      );
    }
  }
  return Object.fromEntries(
    Object.entries(input).map(([key, child]) => [key, inlineLocalReferences(child, root, seen)]),
  );
}
function resolveJsonPointer(root: unknown, reference: string): unknown {
  let value = root;
  for (const segment of reference
    .slice(2)
    .split('/')
    .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))) {
    if (!value || typeof value !== 'object') return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}
function containsReference(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsReference);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value as Record<string, unknown>).some(
    ([key, child]) => key === '$ref' || containsReference(child),
  );
}
function hashId(value: string): string {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).padStart(8, '0').slice(-8);
}
function nextMistralHash(original: string, reverse: ReadonlyMap<string, string>): string {
  let attempt = 0;
  for (;;) {
    const id = `f${hashId(`${original}:${String(attempt++)}`)}`;
    if (!reverse.has(id) || reverse.get(id) === original) return id;
  }
}
export function promptCacheOptions(
  provider: string,
  enabled: boolean,
  cacheKey: string,
): Record<string, string | { type: 'ephemeral' }> {
  if (!enabled) return {};
  if (provider === 'anthropic') return { cache_control: { type: 'ephemeral' } };
  if (provider === 'openai') return { prompt_cache_key: cacheKey };
  return {};
}
