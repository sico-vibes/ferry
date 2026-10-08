import type { ModelMessage } from 'ai';

/** Base64 encodes pixels, not text tokens. Budget image parts without counting their bytes. */
export function serializeMessagesForEstimate(messages: readonly ModelMessage[]): string {
  return JSON.stringify(messages, (_key, value: unknown) => {
    if (typeof value !== 'object' || value === null) return value;
    const part = value as Record<string, unknown>;
    if (
      part.type === 'file' &&
      typeof part.mediaType === 'string' &&
      part.mediaType.startsWith('image/')
    ) {
      // Conservative 1K-token allowance per viewport image; actual usage comes from the provider.
      return { type: 'text', text: 'img '.repeat(1024) };
    }
    return value;
  });
}
