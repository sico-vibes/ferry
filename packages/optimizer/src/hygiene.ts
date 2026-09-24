import { estimateTokens } from './measurement.js';
import { measured, type OptimizationResult } from './measurement.js';
import type { BlobStore } from './recovery.js';

export interface ContextMessage {
  role: string;
  content: string;
  step?: number;
  path?: string;
  kind?: string;
  handle?: string;
}
export interface HygieneOptions {
  currentStep: number;
  staleAfterSteps?: number;
  blobStore: BlobStore;
  sessionId?: string;
  maxPayloadTokens?: number;
}
function saveOriginal(message: ContextMessage, options: HygieneOptions): ContextMessage {
  const handle = options.blobStore.put(options.sessionId ?? 'default', message.content);
  return { ...message, content: `${message.content}\n[Full output saved as ${handle}]`, handle };
}
export function compressJsonPayload(text: string, sampleSize = 3): string {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return text;
  }
  const visit = (node: unknown): unknown => {
    if (Array.isArray(node))
      return node.length > sampleSize * 2
        ? [
            ...node.slice(0, sampleSize).map(visit),
            `... ${String(node.length - sampleSize * 2)} items omitted ...`,
            ...node.slice(-sampleSize).map(visit),
          ]
        : node.map(visit);
    if (node && typeof node === 'object') {
      const result: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(node)) result[key] = visit(item);
      return result;
    }
    return node;
  };
  return JSON.stringify(visit(value), null, 2);
}
export function hygieneMessages(
  messages: readonly ContextMessage[],
  options: HygieneOptions,
): ContextMessage[] {
  const seenPaths = new Map<string, { step: number; content: string }>();
  const threshold = options.staleAfterSteps ?? 5;
  const maxTokens = options.maxPayloadTokens ?? 1200;
  return messages.map((message) => {
    if (message.path && message.kind === 'file-read') {
      const previous = seenPaths.get(message.path);
      seenPaths.set(message.path, {
        step: message.step ?? options.currentStep,
        content: message.content,
      });
      if (previous?.content === message.content)
        return {
          ...message,
          content: `[${message.path} unchanged since step ${String(previous.step)}]`,
        };
    }
    if (
      message.step !== undefined &&
      options.currentStep - message.step >= threshold &&
      message.kind === 'tool-result'
    ) {
      const saved = saveOriginal(message, options);
      const first = message.content.split(/\r?\n/).find((line) => line.trim()) ?? '(empty output)';
      return {
        ...saved,
        content: `Older tool result (step ${String(message.step)}): ${first.slice(0, 180)} [recover ${saved.handle ?? ''}]`,
      };
    }
    const looksPayload =
      message.kind === 'json' ||
      /^(\s*[{[]|\s*<!doctype html|\s*<html)/i.test(message.content) ||
      (message.kind === 'tool-result' && estimateTokens(message.content) > maxTokens);
    if (looksPayload && estimateTokens(message.content) > maxTokens) {
      const saved = saveOriginal(message, options);
      const compressed = compressPayload(message.content);
      const clipped =
        estimateTokens(compressed) > maxTokens
          ? compressed.split(/\r?\n/).slice(0, Math.max(1, maxTokens)).join('\n') +
            '\n… payload elided …'
          : compressed;
      return { ...saved, content: `${clipped}\n[Full payload saved as ${saved.handle ?? ''}]` };
    }
    return message;
  });
}

export function optimizeContextMessages(
  messages: readonly ContextMessage[],
  options: HygieneOptions,
): OptimizationResult<ContextMessage[]> {
  const output = hygieneMessages(messages, options);
  return measured('context-hygiene', JSON.stringify(messages), output, JSON.stringify(output));
}

function compressPayload(text: string): string {
  const json = compressJsonPayload(text);
  if (json !== text) return json;
  if (/^\s*<!doctype html|^\s*<html/i.test(text)) {
    const cleaned = text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
    const lines = cleaned.split(/\r?\n/);
    if (lines.length < 40) return cleaned;
    const errors = lines.filter((line) => /error|warning|exception|failed/i.test(line));
    return [
      ...lines.slice(0, 15),
      '<!-- … markup elided … -->',
      ...errors.slice(0, 10),
      ...lines.slice(-10),
    ].join('\n');
  }
  const lines = text.split(/\r?\n/);
  if (lines.length > 40) {
    const diagnostics = lines.filter((line) =>
      /error|warning|exception|failed|traceback/i.test(line),
    );
    return [
      ...lines.slice(0, 10),
      `... ${String(lines.length - 20)} log lines elided ...`,
      ...diagnostics.slice(0, 20),
      ...lines.slice(-10),
    ].join('\n');
  }
  return text;
}
