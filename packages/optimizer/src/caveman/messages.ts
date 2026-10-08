import type { Message, OptimizerToggles } from '@ferry/shared';
import { cavemanCompress, type CavemanResult } from './compress.js';
import { isCodeLike } from './preserve.js';

export type CavemanInputCache = Map<
  string,
  { source: string; level: string; result: CavemanResult }
>;

export interface CavemanMessagesResult {
  messages: Message[];
  event?: {
    kind: 'caveman-input';
    beforeTokens: number;
    afterTokens: number;
    recoveryHandle: null;
  };
}

/** Provider context only: never mutate durable history, arguments, or file data. */
export function compressCavemanMessages(
  messages: readonly Message[],
  level: OptimizerToggles['cavemanInput'],
  cache: CavemanInputCache = new Map(),
  measureContext?: (messages: readonly Message[]) => number,
): CavemanMessagesResult {
  if (level === 'off') return { messages: [...messages] };
  const latestUser = messages.findLastIndex((message) => message.role === 'user');
  let beforeTokens = 0;
  let afterTokens = 0;
  const compress = (id: string, text: string, toolOutput = false): string => {
    if (text.length <= 200 || (toolOutput && isCodeLike(text))) return text;
    const cached = cache.get(id);
    const reusable = cached?.source === text && cached.level === level;
    const result = reusable ? cached.result : cavemanCompress(text, { intensity: level });
    if (!reusable) cache.set(id, { source: text, level, result });
    // Bound session cache memory without introducing nondeterministic content.
    if (cache.size > 2048) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    beforeTokens += result.beforeTokens;
    afterTokens += result.afterTokens;
    return result.text;
  };
  const output = messages.map((message, index) => ({
    ...message,
    parts: message.parts.map((part) => {
      if (part.type === 'text' && index < latestUser)
        return { ...part, text: compress(`${message.id}:${part.id}:text`, part.text) };
      if (
        part.type === 'tool_call' &&
        part.output &&
        // Unknown tool sources with file/path/content arguments may return file
        // data too. Favor preservation over savings for those tools.
        !/read|file|cat|recovery|output_read/i.test(part.tool) &&
        !['path', 'file', 'filePath', 'file_path', 'content', 'contents'].some(
          (key) => key in part.args,
        ) &&
        !(
          typeof part.args.command === 'string' &&
          /\b(?:cat|type|Get-Content|head|tail|sed|awk|bat|less|more|Select-String)\b/i.test(
            part.args.command,
          )
        )
      )
        return {
          ...part,
          output: {
            ...part.output,
            text: compress(`${message.id}:${part.id}:output`, part.output.text, true),
          },
        };
      return part;
    }),
  }));
  if (measureContext) {
    const hasEligibleText = beforeTokens > 0;
    beforeTokens = measureContext(messages);
    afterTokens = hasEligibleText ? measureContext(output) : beforeTokens;
    // Later provider-context trimming can outweigh prose savings. Count only
    // the text actually assembled for the model and keep the smaller context.
    if (afterTokens > beforeTokens)
      return {
        messages: [...messages],
        event: {
          kind: 'caveman-input',
          beforeTokens,
          afterTokens: beforeTokens,
          recoveryHandle: null,
        },
      };
  }
  return {
    messages: output,
    event: { kind: 'caveman-input', beforeTokens, afterTokens, recoveryHandle: null },
  };
}
