import { z } from 'zod';

const base = {
  id: z.string().min(1),
  timestamp: z.iso.datetime(),
  durationMs: z.number().nonnegative().nullable().optional(),
  truncated: z.boolean().optional(),
};

export const AgentEventSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('text'), content: z.string() }),
  z.object({ ...base, type: z.literal('thinking'), content: z.string() }),
  z.object({
    ...base,
    type: z.literal('tool_use'),
    callId: z.string(),
    tool: z.string(),
    input: z.unknown(),
  }),
  z.object({
    ...base,
    type: z.literal('tool_result'),
    callId: z.string(),
    output: z.string(),
    recoveryHandle: z.string().optional(),
  }),
  z.object({
    ...base,
    type: z.literal('status'),
    status: z.string(),
    message: z.string().optional(),
    reasoningAvailable: z.boolean().optional(),
  }),
  z.object({ ...base, type: z.literal('error'), message: z.string() }),
  z.object({
    ...base,
    type: z.literal('usage'),
    inputTokens: z.number().nonnegative().optional(),
    outputTokens: z.number().nonnegative().optional(),
    reasoningTokens: z.number().nonnegative().optional(),
    costUsd: z.number().nonnegative().nullable().optional(),
  }),
]);

export type AgentEvent = z.infer<typeof AgentEventSchema>;

export function summarizeAgentEvent(event: AgentEvent): string {
  switch (event.type) {
    case 'text':
    case 'thinking':
      return event.content;
    case 'tool_use':
      return `Tool: ${event.tool}`;
    case 'tool_result':
      return `Tool result: ${event.output}`;
    case 'status':
      return event.message ?? event.status;
    case 'error':
      return event.message;
    case 'usage':
      return `Usage: ${String(event.inputTokens ?? 0)}/${String(event.outputTokens ?? 0)}`;
  }
}

/** Extracts reasoning across AI SDK provider stream shapes without treating ordinary text as reasoning. */
export function normalizeReasoningPart(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const part = value as Record<string, unknown>;
  const type = typeof part.type === 'string' ? part.type.toLowerCase() : '';
  const direct = [part.reasoning_content, part.reasoning, part.thinking];
  for (const candidate of direct)
    if (typeof candidate === 'string' && candidate.length) return candidate;
  if (type.includes('reasoning') || part.thought === true) {
    for (const candidate of [part.delta, part.text, part.content])
      if (typeof candidate === 'string' && candidate.length) return candidate;
  }
  return undefined;
}

export function normalizeInlineThinking(input: string): { text: string; thinking: string } {
  const thinking: string[] = [];
  const text = input.replace(/<think>([\s\S]*?)<\/think>/gi, (_match, content: string) => {
    thinking.push(content);
    return '';
  });
  return { text, thinking: thinking.join('\n').trim() };
}
