export interface CompactableMessage {
  role: string;
  content?: string;
  toolOutput?: boolean;
  protected?: boolean;
  recoveryHandle?: string;
}
export interface CompactedContext<T extends CompactableMessage> {
  messages: T[];
  pruned: number;
  summary: string;
}
export function compactContext<T extends CompactableMessage>(
  messages: readonly T[],
  contextWindow: number,
  estimate: (text: string) => number,
  options: {
    threshold?: number;
    protectedTail?: number;
    maxToolLines?: number;
    maxToolBytes?: number;
  } = {},
): CompactedContext<T> {
  const threshold = options.threshold ?? 0.9;
  const protectedTail = options.protectedTail ?? 6;
  const maxLines = options.maxToolLines ?? 2000;
  const maxBytes = options.maxToolBytes ?? 10000;
  const normalized = messages.map((message) => {
    if (!message.toolOutput || typeof message.content !== 'string') return { ...message };
    const lines = message.content.split(/\r?\n/);
    const clipped = lines.length > maxLines ? lines.slice(0, maxLines).join('\n') : message.content;
    const bounded = utf8Prefix(clipped, maxBytes);
    return {
      ...message,
      content:
        bounded === clipped
          ? bounded
          : bounded + '\n[output truncated; use recovery handle to retrieve the full output]',
    };
  });
  let tokens = normalized.reduce((sum, message) => sum + estimate(message.content ?? ''), 0);
  let pruned = 0;
  if (tokens > contextWindow * threshold) {
    for (
      let i = 0;
      i < Math.max(0, normalized.length - protectedTail) && tokens > contextWindow * threshold;
      i++
    ) {
      const message = normalized[i];
      if (!message?.toolOutput || message.protected || !message.content) continue;
      tokens -= estimate(message.content);
      normalized[i] = {
        ...message,
        content:
          '[older tool output pruned; retrieve it using recovery handle ' +
          (message.recoveryHandle ?? '(unavailable)') +
          ']',
      };
      tokens += estimate(normalized[i]?.content ?? '');
      pruned++;
    }
  }
  const summary = pruned
    ? String(pruned) + ' older tool output(s) were pruned to fit the context window.'
    : '';
  return { messages: normalized, pruned, summary };
}
function utf8Prefix(text: string, maxBytes: number): string {
  let result = '';
  let bytes = 0;
  for (const character of text) {
    const size = new TextEncoder().encode(character).length;
    if (bytes + size > maxBytes) break;
    result += character;
    bytes += size;
  }
  return result;
}
