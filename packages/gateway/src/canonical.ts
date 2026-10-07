import type { GatewayMessage } from './index.js';
import { EffortSchema, type Effort } from '@ferry/shared';

export type CanonicalPart =
  | { type: 'text'; text: string }
  | { type: 'image'; url: string; detail?: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_result'; toolCallId: string; content: string };

export interface CanonicalToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface CanonicalMessage {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool';
  parts: CanonicalPart[];
  toolCalls?: CanonicalToolCall[];
  toolCallId?: string;
}

export interface CanonicalTool {
  name: string;
  description?: string;
  parameters: unknown;
}

export interface CanonicalRequest {
  model: string;
  messages: CanonicalMessage[];
  tools?: CanonicalTool[];
  toolChoice?: unknown;
  maxTokens?: number;
  temperature?: number;
  effort?: Effort;
  stream: boolean;
}
function canonicalReasoningEffort(input: Record<string, unknown>): { effort?: Effort } {
  const nested =
    input.reasoning && typeof input.reasoning === 'object'
      ? (input.reasoning as Record<string, unknown>).effort
      : undefined;
  const parsed = EffortSchema.safeParse(input.reasoning_effort ?? nested);
  return parsed.success ? { effort: parsed.data } : {};
}

export interface CanonicalUsage {
  inputTokens: number;
  cachedTokens?: number;
  outputTokens: number;
}

export interface CanonicalResponse {
  id: string;
  model: string;
  text: string;
  reasoning?: string;
  toolCalls: CanonicalToolCall[];
  usage: CanonicalUsage;
  finishReason: string;
}

export type CanonicalStreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'tool_call'; call: CanonicalToolCall }
  | { type: 'completed'; finishReason: string; usage: CanonicalUsage }
  | { type: 'failed'; message: string };

export interface CanonicalStreamFinal {
  events: CanonicalStreamEvent[];
  finishReason: string;
  usage: CanonicalUsage;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  return value === undefined || value === null ? fallback : JSON.stringify(value);
}

function parts(value: unknown): CanonicalPart[] {
  if (typeof value === 'string') return value ? [{ type: 'text', text: value }] : [];
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw): CanonicalPart[] => {
    const part = record(raw);
    if (!part) return [];
    if (
      typeof part.text === 'string' &&
      ['text', 'input_text', 'output_text'].includes(String(part.type))
    )
      return [{ type: 'text', text: part.text }];
    if (typeof part.refusal === 'string') return [{ type: 'text', text: part.refusal }];
    const image = record(part.image_url) ?? record(part.source) ?? record(part);
    const source = record(part.source);
    const rawUrl = typeof part.image_url === 'string' ? part.image_url : image?.url;
    const url =
      typeof rawUrl === 'string'
        ? rawUrl
        : source?.type === 'base64' && typeof source.data === 'string'
          ? `data:${stringValue(source.media_type, 'image/jpeg')};base64,${source.data}`
          : undefined;
    if (String(part.type).includes('image')) {
      const validUrl =
        typeof url === 'string' &&
        (/^https?:\/\/\S+$/i.test(url) ||
          /^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/]+={0,2}$/i.test(url));
      if (!validUrl)
        throw Object.assign(new Error('Image URL must be HTTP(S) or valid base64 image data'), {
          name: 'AI_InvalidPromptError',
        });
      return [
        {
          type: 'image',
          url,
          ...(typeof image?.detail === 'string' ? { detail: image.detail } : {}),
        },
      ];
    }
    if (part.type === 'thinking' && typeof part.thinking === 'string')
      return [{ type: 'reasoning', text: part.thinking }];
    if (part.type === 'reasoning' && Array.isArray(part.summary))
      return part.summary.flatMap((rawPart): CanonicalPart[] => {
        const summary = record(rawPart);
        return typeof summary?.text === 'string' ? [{ type: 'reasoning', text: summary.text }] : [];
      });
    if (part.type === 'tool_result' && typeof part.tool_use_id === 'string')
      return [
        {
          type: 'tool_result',
          toolCallId: part.tool_use_id,
          content:
            typeof part.content === 'string' ? part.content : JSON.stringify(part.content ?? ''),
        },
      ];
    if (
      part.type === 'tool_use' ||
      part.type === 'function_call' ||
      part.type === 'function_call_output'
    )
      return [];
    const kind = typeof part.type === 'string' ? part.type : 'unknown';
    throw Object.assign(new Error(`Unsupported ${kind} content block`), {
      name: 'AI_InvalidPromptError',
    });
  });
}

function message(value: unknown): CanonicalMessage | undefined {
  const item = record(value);
  if (!item || typeof item.role !== 'string') return undefined;
  const role = item.role === 'function' ? 'tool' : item.role;
  if (!['system', 'developer', 'user', 'assistant', 'tool'].includes(role)) return undefined;
  const calls = Array.isArray(item.tool_calls)
    ? item.tool_calls.flatMap((raw): CanonicalToolCall[] => {
        const call = record(raw);
        const fn = record(call?.function);
        if (typeof call?.id !== 'string' || typeof fn?.name !== 'string') return [];
        return [
          {
            id: call.id,
            name: fn.name,
            arguments:
              typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
          },
        ];
      })
    : undefined;
  return {
    role: role as CanonicalMessage['role'],
    parts: parts(item.content),
    ...(calls?.length ? { toolCalls: calls } : {}),
    ...(typeof item.tool_call_id === 'string' ? { toolCallId: item.tool_call_id } : {}),
  };
}

function convertTools(raw: unknown): CanonicalTool[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const result = raw.flatMap((entry): CanonicalTool[] => {
    const item = record(entry);
    if (!item) return [];
    const fn = record(item.function) ?? item;
    if (typeof fn.name !== 'string') return [];
    return [
      {
        name: fn.name,
        ...(typeof fn.description === 'string' ? { description: fn.description } : {}),
        parameters: fn.parameters ?? fn.input_schema ?? {},
      },
    ];
  });
  return result;
}

export function openAiChatToCanonical(input: Record<string, unknown>): CanonicalRequest {
  if (typeof input.model !== 'string' || !Array.isArray(input.messages))
    throw new Error('model and messages are required');
  const tools = convertTools(input.tools);
  return {
    model: input.model,
    messages: input.messages.map(message).filter((item): item is CanonicalMessage => Boolean(item)),
    ...(tools ? { tools } : {}),
    ...(input.tool_choice !== undefined ? { toolChoice: input.tool_choice } : {}),
    ...(typeof input.max_tokens === 'number' ? { maxTokens: input.max_tokens } : {}),
    ...(typeof input.temperature === 'number' ? { temperature: input.temperature } : {}),
    ...canonicalReasoningEffort(input),
    stream: input.stream === true,
  };
}

export function openAiResponsesToCanonical(input: Record<string, unknown>): CanonicalRequest {
  if (input.previous_response_id !== undefined)
    throw new Error('previous_response_id is not supported by Ferry Gateway');
  if (typeof input.model !== 'string') throw new Error('model is required');
  const rawInput = input.input;
  const items = Array.isArray(rawInput) ? rawInput : [{ role: 'user', content: rawInput }];
  const messages = items.flatMap((raw): CanonicalMessage[] => {
    const item = record(raw);
    if (!item) return [];
    if (item.type === 'function_call_output')
      return [
        {
          role: 'tool',
          parts: [
            {
              type: 'tool_result',
              toolCallId: stringValue(item.call_id),
              content: stringValue(item.output),
            },
          ],
          toolCallId: stringValue(item.call_id),
        },
      ];
    if (item.type === 'function_call')
      return [
        {
          role: 'assistant',
          parts: [],
          toolCalls: [
            {
              id: stringValue(item.call_id ?? item.id),
              name: stringValue(item.name),
              arguments:
                typeof item.arguments === 'string'
                  ? item.arguments
                  : JSON.stringify(item.arguments ?? {}),
            },
          ],
        },
      ];
    if (item.type === 'reasoning')
      return [
        {
          role: 'assistant',
          parts: Array.isArray(item.summary)
            ? item.summary.flatMap((part): CanonicalPart[] => {
                const summary = record(part);
                return typeof summary?.text === 'string'
                  ? [{ type: 'reasoning', text: summary.text }]
                  : [];
              })
            : parts(item),
        },
      ];
    const role = typeof item.role === 'string' ? item.role : 'user';
    const content = item.content ?? item;
    return [{ role: role as CanonicalMessage['role'], parts: parts(content) }];
  });
  const tools = Array.isArray(input.tools)
    ? input.tools.map((tool) => {
        const item = record(tool) ?? {};
        return {
          type: 'function',
          function: { name: item.name, description: item.description, parameters: item.parameters },
        };
      })
    : undefined;
  const canonicalTools = convertTools(tools);
  return {
    model: input.model,
    messages,
    ...(canonicalTools ? { tools: canonicalTools } : {}),
    ...(input.tool_choice !== undefined ? { toolChoice: input.tool_choice } : {}),
    ...(typeof input.max_output_tokens === 'number' ? { maxTokens: input.max_output_tokens } : {}),
    ...canonicalReasoningEffort(input),
    stream: input.stream === true,
  };
}

export function anthropicToCanonical(input: Record<string, unknown>): CanonicalRequest {
  const sourceMessages: unknown[] = [
    ...(input.system === undefined ? [] : [{ role: 'system', content: input.system }]),
    ...(Array.isArray(input.messages) ? (input.messages as unknown[]) : []),
  ];
  const messages = sourceMessages.flatMap((raw): CanonicalMessage[] => {
    const item = record(raw);
    if (!item || typeof item.role !== 'string') return [];
    const content = Array.isArray(item.content)
      ? item.content
      : [{ type: 'text', text: item.content }];
    const calls = content.flatMap((part): CanonicalToolCall[] => {
      const block = record(part);
      return block?.type === 'tool_use' &&
        typeof block.id === 'string' &&
        typeof block.name === 'string'
        ? [{ id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) }]
        : [];
    });
    return [
      {
        role: item.role as CanonicalMessage['role'],
        parts: parts(content),
        ...(calls.length ? { toolCalls: calls } : {}),
      },
    ];
  });
  const tools = Array.isArray(input.tools)
    ? input.tools.map((raw) => {
        const item = record(raw) ?? {};
        return { name: item.name, description: item.description, parameters: item.input_schema };
      })
    : undefined;
  const canonicalTools = convertTools(tools);
  return {
    model: stringValue(input.model),
    messages,
    ...(canonicalTools ? { tools: canonicalTools } : {}),
    stream: input.stream === true,
    ...(typeof input.max_tokens === 'number' ? { maxTokens: input.max_tokens } : {}),
  };
}

export function geminiToCanonical(input: Record<string, unknown>, model: string): CanonicalRequest {
  const contents = Array.isArray(input.contents) ? input.contents : [];
  const messages = contents.flatMap((raw): CanonicalMessage[] => {
    const item = record(raw);
    if (!item || typeof item.role !== 'string') return [];
    const role = item.role === 'model' ? 'assistant' : item.role;
    const content = Array.isArray(item.parts) ? item.parts : [];
    const text = content.flatMap((part) => {
      const value = record(part);
      return typeof value?.text === 'string' ? [{ type: 'text' as const, text: value.text }] : [];
    });
    const calls = content.flatMap((part): CanonicalToolCall[] => {
      const value = record(part);
      const call = record(value?.functionCall);
      return call && typeof call.name === 'string'
        ? [
            {
              id: stringValue(call.id, `call_${call.name}`),
              name: call.name,
              arguments: JSON.stringify(call.args ?? {}),
            },
          ]
        : [];
    });
    const results = content.flatMap((part): CanonicalPart[] => {
      const value = record(part);
      const response = record(value?.functionResponse);
      return response
        ? [
            {
              type: 'tool_result',
              toolCallId: stringValue(
                response.id,
                typeof response.name === 'string' ? `call_${response.name}` : '',
              ),
              content: JSON.stringify(response.response ?? {}),
            },
          ]
        : [];
    });
    const images = content.flatMap((part): CanonicalPart[] => {
      const value = record(part);
      const data = record(value?.inlineData);
      return data && typeof data.data === 'string'
        ? [
            {
              type: 'image',
              url: `data:${stringValue(data.mimeType, 'image/jpeg')};base64,${data.data}`,
            },
          ]
        : [];
    });
    return [
      {
        role: role as CanonicalMessage['role'],
        parts: [...text, ...results, ...images],
        ...(calls.length ? { toolCalls: calls } : {}),
      },
    ];
  });
  const systemText = record(input.systemInstruction)?.parts;
  if (Array.isArray(systemText)) messages.unshift({ role: 'system', parts: parts(systemText) });
  const toolsRaw = Array.isArray(input.tools)
    ? input.tools.flatMap((entry) =>
        Array.isArray(record(entry)?.functionDeclarations)
          ? (record(entry)?.functionDeclarations as unknown[])
          : [],
      )
    : [];
  const tools = toolsRaw.map((raw) => {
    const tool = record(raw) ?? {};
    return { name: tool.name, description: tool.description, parameters: tool.parameters };
  });
  const canonicalTools = convertTools(tools);
  const config = record(input.generationConfig) ?? {};
  return {
    model,
    messages,
    ...(canonicalTools ? { tools: canonicalTools } : {}),
    ...(typeof config.maxOutputTokens === 'number' ? { maxTokens: config.maxOutputTokens } : {}),
    ...(typeof config.temperature === 'number' ? { temperature: config.temperature } : {}),
    stream: false,
  };
}

export function canonicalToGatewayMessages(messages: CanonicalMessage[]): {
  messages: GatewayMessage[];
  instructions: string;
} {
  const instructions = messages
    .filter((item) => item.role === 'system' || item.role === 'developer')
    .flatMap((item) => item.parts.map((part) => (part.type === 'text' ? part.text : '')))
    .filter(Boolean)
    .join('\n\n');
  const converted = messages
    .filter((item) => item.role !== 'system' && item.role !== 'developer')
    .flatMap((item): GatewayMessage[] => {
      const results = item.parts.flatMap((part): GatewayMessage[] =>
        part.type === 'tool_result'
          ? [{ role: 'tool', tool_call_id: part.toolCallId, content: part.content }]
          : [],
      );
      const visible = item.parts.filter((part) => part.type !== 'tool_result');
      const providerVisible = visible.filter(
        (part) => part.type === 'text' || part.type === 'image',
      );
      const text = providerVisible
        .filter((part) => part.type === 'text')
        .map((part) => (part as { text: string }).text)
        .join('');
      const imageParts = providerVisible
        .filter((part) => part.type === 'image')
        .map((part) => ({ type: 'image', image: (part as { url: string }).url }));
      const toolCalls = item.toolCalls?.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments },
      }));
      const message: GatewayMessage = {
        role: item.role,
        content: imageParts.length
          ? [...(text ? [{ type: 'text', text }] : []), ...imageParts]
          : text,
        ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
        ...(item.toolCallId ? { tool_call_id: item.toolCallId } : {}),
      };
      return [...results, ...(providerVisible.length || toolCalls?.length ? [message] : [])];
    });
  return { instructions, messages: converted };
}

export function canonicalToOpenAiChat(
  messages: CanonicalMessage[],
  usage: CanonicalUsage,
  finishReason: string,
): unknown {
  const assistant = [...messages].reverse().find((item) => item.role === 'assistant');
  return {
    role: 'assistant',
    content:
      assistant?.parts
        .filter((part) => part.type === 'text')
        .map((part) => (part as { text: string }).text)
        .join('') ?? '',
    ...(assistant?.toolCalls
      ? {
          tool_calls: assistant.toolCalls.map((call) => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: call.arguments },
          })),
        }
      : {}),
    finish_reason: finishReason,
    usage: {
      prompt_tokens: usage.inputTokens,
      prompt_tokens_details: { cached_tokens: usage.cachedTokens ?? 0 },
      completion_tokens: usage.outputTokens,
      total_tokens: usage.inputTokens + usage.outputTokens,
    },
  };
}

export function canonicalToAnthropicMessage(response: CanonicalResponse): unknown {
  return {
    id: response.id,
    type: 'message',
    role: 'assistant',
    model: response.model,
    content: [
      ...(response.text ? [{ type: 'text', text: response.text }] : []),
      ...response.toolCalls.map((call) => ({
        type: 'tool_use',
        id: call.id,
        name: call.name,
        input: parseJson(call.arguments),
      })),
    ],
    stop_reason: response.toolCalls.length ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: response.usage.inputTokens,
      cache_read_input_tokens: response.usage.cachedTokens ?? 0,
      output_tokens: response.usage.outputTokens,
    },
  };
}

export function canonicalToResponses(response: CanonicalResponse): unknown {
  return {
    id: response.id,
    object: 'response',
    status: 'completed',
    model: response.model,
    output: [
      ...(response.reasoning
        ? [
            {
              type: 'reasoning',
              id: `${response.id}_reasoning`,
              summary: [{ type: 'summary_text', text: response.reasoning }],
            },
          ]
        : []),
      ...(response.text
        ? [
            {
              type: 'message',
              id: `${response.id}_message`,
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: response.text, annotations: [] }],
            },
          ]
        : []),
      ...response.toolCalls.map((call) => ({
        type: 'function_call',
        id: call.id,
        call_id: call.id,
        name: call.name,
        arguments: call.arguments,
        status: 'completed',
      })),
    ],
    output_text: response.text,
    usage: {
      input_tokens: response.usage.inputTokens,
      input_tokens_details: { cached_tokens: response.usage.cachedTokens ?? 0 },
      output_tokens: response.usage.outputTokens,
      total_tokens: response.usage.inputTokens + response.usage.outputTokens,
    },
  };
}

export function canonicalToGemini(response: CanonicalResponse): unknown {
  return {
    candidates: [
      {
        content: {
          role: 'model',
          parts: [
            ...(response.text ? [{ text: response.text }] : []),
            ...response.toolCalls.map((call) => ({
              functionCall: { id: call.id, name: call.name, args: parseJson(call.arguments) },
            })),
          ],
        },
        finishReason: response.toolCalls.length ? 'STOP' : 'STOP',
        index: 0,
      },
    ],
    usageMetadata: {
      promptTokenCount: response.usage.inputTokens,
      cachedContentTokenCount: response.usage.cachedTokens ?? 0,
      candidatesTokenCount: response.usage.outputTokens,
      totalTokenCount: response.usage.inputTokens + response.usage.outputTokens,
    },
    modelVersion: response.model,
  };
}

export function canonicalStreamEventsToResponses(
  events: CanonicalStreamEvent[],
  responseId: string,
): unknown[] {
  return events.flatMap((event): unknown[] => {
    if (event.type === 'text_delta')
      return [
        {
          type: 'response.output_text.delta',
          item_id: `${responseId}_message`,
          output_index: 0,
          content_index: 0,
          delta: event.text,
        },
      ];
    if (event.type === 'reasoning_delta')
      return [
        {
          type: 'response.reasoning_summary_text.delta',
          item_id: `${responseId}_reasoning`,
          output_index: 0,
          summary_index: 0,
          delta: event.text,
        },
      ];
    if (event.type === 'tool_call')
      return [
        {
          type: 'response.function_call_arguments.delta',
          item_id: event.call.id,
          delta: event.call.arguments,
        },
      ];
    if (event.type === 'completed')
      return [
        {
          type: 'response.completed',
          usage: {
            input_tokens: event.usage.inputTokens,
            input_tokens_details: { cached_tokens: event.usage.cachedTokens ?? 0 },
            output_tokens: event.usage.outputTokens,
            total_tokens: event.usage.inputTokens + event.usage.outputTokens,
          },
        },
      ];
    return [{ type: 'error', message: event.message }];
  });
}

export function canonicalStreamEventsToGemini(events: CanonicalStreamEvent[]): unknown[] {
  return events.flatMap((event): unknown[] => {
    if (event.type === 'text_delta')
      return [
        { candidates: [{ content: { role: 'model', parts: [{ text: event.text }] }, index: 0 }] },
      ];
    if (event.type === 'tool_call')
      return [
        {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  {
                    functionCall: {
                      id: event.call.id,
                      name: event.call.name,
                      args: parseJson(event.call.arguments),
                    },
                  },
                ],
              },
              index: 0,
            },
          ],
        },
      ];
    if (event.type === 'completed')
      return [
        {
          usageMetadata: {
            promptTokenCount: event.usage.inputTokens,
            cachedContentTokenCount: event.usage.cachedTokens ?? 0,
            candidatesTokenCount: event.usage.outputTokens,
            totalTokenCount: event.usage.inputTokens + event.usage.outputTokens,
          },
        },
      ];
    if (event.type === 'failed') return [{ error: { message: event.message } }];
    return [];
  });
}

export function canonicalStreamEventsToOpenAiChat(events: CanonicalStreamEvent[]): unknown[] {
  return events.flatMap((event, index): unknown[] => {
    if (event.type === 'text_delta')
      return [{ choices: [{ index: 0, delta: { content: event.text }, finish_reason: null }] }];
    if (event.type === 'tool_call')
      return [
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index,
                    id: event.call.id,
                    type: 'function',
                    function: { name: event.call.name, arguments: event.call.arguments },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
      ];
    if (event.type === 'completed')
      return [
        {
          choices: [{ index: 0, delta: {}, finish_reason: event.finishReason }],
          usage: {
            prompt_tokens: event.usage.inputTokens,
            prompt_tokens_details: { cached_tokens: event.usage.cachedTokens ?? 0 },
            completion_tokens: event.usage.outputTokens,
            total_tokens: event.usage.inputTokens + event.usage.outputTokens,
          },
        },
      ];
    if (event.type === 'failed') return [{ error: { message: event.message } }];
    return [];
  });
}

export function canonicalStreamEventsToAnthropic(
  events: CanonicalStreamEvent[],
  messageId = 'msg_canonical',
): unknown[] {
  return events.flatMap((event, index): unknown[] => {
    if (event.type === 'text_delta')
      return [
        ...(index === 0
          ? [
              {
                type: 'message_start',
                message: {
                  id: messageId,
                  type: 'message',
                  role: 'assistant',
                  content: [],
                  stop_reason: null,
                  stop_sequence: null,
                  usage: { input_tokens: 0, output_tokens: 0 },
                },
              },
            ]
          : []),
        ...(index === 0
          ? [{ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }]
          : []),
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: event.text } },
      ];
    if (event.type === 'tool_call')
      return [
        ...(index === 0
          ? [
              {
                type: 'message_start',
                message: {
                  id: messageId,
                  type: 'message',
                  role: 'assistant',
                  content: [],
                  stop_reason: null,
                  stop_sequence: null,
                  usage: { input_tokens: 0, output_tokens: 0 },
                },
              },
            ]
          : []),
        {
          type: 'content_block_start',
          index,
          content_block: { type: 'tool_use', id: event.call.id, name: event.call.name, input: {} },
        },
        {
          type: 'content_block_delta',
          index,
          delta: { type: 'input_json_delta', partial_json: event.call.arguments },
        },
        { type: 'content_block_stop', index },
      ];
    if (event.type === 'completed')
      return [
        ...(index === 0
          ? [
              {
                type: 'message_start',
                message: {
                  id: messageId,
                  type: 'message',
                  role: 'assistant',
                  content: [],
                  stop_reason: null,
                  stop_sequence: null,
                  usage: { input_tokens: 0, output_tokens: 0 },
                },
              },
            ]
          : []),
        {
          type: 'message_delta',
          delta: {
            stop_reason: event.finishReason === 'tool_calls' ? 'tool_use' : 'end_turn',
            stop_sequence: null,
          },
          usage: { input_tokens: event.usage.inputTokens, output_tokens: event.usage.outputTokens },
        },
        { type: 'message_stop' },
      ];
    if (event.type === 'failed')
      return [{ type: 'error', error: { type: 'api_error', message: event.message } }];
    return [];
  });
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

export function finalizeCanonicalStream(
  events: CanonicalStreamEvent[],
  finishReason: string,
  usage: CanonicalUsage,
): CanonicalStreamFinal {
  return { events: [...events, { type: 'completed', finishReason, usage }], finishReason, usage };
}
