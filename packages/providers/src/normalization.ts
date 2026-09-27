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
  const result: unknown[] = [];
  let needsAssistant = false;
  for (const message of messages) {
    const record = structuredClone(message) as unknown as Record<string, unknown>;
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
                ? clean(value.toolCallId)
                    .replace(/[^a-zA-Z0-9]/g, '')
                    .slice(0, 9)
                    .padEnd(9, '0')
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
  if (Array.isArray(schema)) return schema.map((item) => normalizeToolSchema(item, provider));
  if (!schema || typeof schema !== 'object') return schema;
  const input = schema as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (['$defs', 'definitions', '$schema', 'examples'].includes(key)) continue;
    if (
      ['openai', 'mistral', 'deepseek'].includes(provider) &&
      ['additionalProperties', 'unevaluatedProperties', 'patternProperties'].includes(key)
    )
      continue;
    output[key] = normalizeToolSchema(value, provider);
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
