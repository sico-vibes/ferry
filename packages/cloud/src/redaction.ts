import { redactKnownSecretText } from '@ferry/shared';

export function contentMarker(value: unknown): { redacted: string; chars: number } {
  return {
    redacted: 'content-capture-off',
    chars: typeof value === 'string' ? value.length : JSON.stringify(value ?? '').length,
  };
}
export function contentMarkerText(value: unknown): string {
  const chars = typeof value === 'string' ? value.length : JSON.stringify(value ?? '').length;
  return `[content capture off: ${String(chars)} chars]`;
}
export function metadataOnly(value: unknown, key = ''): unknown {
  if (typeof value === 'string') {
    return /^(?:id|providerId|sessionId|workspaceId|modelRef|status|kind|createdAt|updatedAt|path|scope|metric|type|role|name|provider|confidence|until|resetAt|enabled|position|keyId)$/i.test(
      key,
    )
      ? value
      : contentMarker(value);
  }
  if (Array.isArray(value)) return value.map((item) => metadataOnly(item));
  if (typeof value === 'object' && value !== null)
    return Object.fromEntries(
      Object.entries(value).map(([childKey, item]) => [childKey, metadataOnly(item, childKey)]),
    );
  return value;
}
export function stripParts(parts: unknown): unknown {
  if (!Array.isArray(parts)) return [];
  const items: unknown[] = parts;
  return items.map((part) => {
    if (typeof part === 'string') return { redacted: 'content-capture-off', chars: part.length };
    if (typeof part !== 'object' || part === null) return part;
    const value = part as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        if (
          /^(?:text|content|reasoning|summary|detail|explanation|before|after)$/i.test(key) &&
          typeof item === 'string'
        )
          return [key, `[content capture off: ${String(item.length)} chars]`];
        if (/^(?:args|arguments|input)$/i.test(key))
          return [
            key,
            { redacted: 'content-capture-off', chars: JSON.stringify(item ?? '').length },
          ];
        if (key === 'output' && typeof item === 'object' && item !== null) {
          const output = item as Record<string, unknown>;
          return [
            key,
            {
              ...output,
              text: `[content capture off: ${String(typeof output.text === 'string' ? output.text.length : 0)} chars]`,
            },
          ];
        }
        return [key, item];
      }),
    );
  });
}
export function flattenTextParts(parts: unknown): string | null {
  if (!Array.isArray(parts)) return null;
  const text = (parts as unknown[])
    .flatMap((part): string[] => {
      if (!part || typeof part !== 'object') return [];
      const value = part as Record<string, unknown>;
      return value.type === 'text' && typeof value.text === 'string' ? [value.text] : [];
    })
    .join('');
  return text || null;
}

/** Redacts known secrets and common credential shapes from queued data and field names. */
export function redactCloudPayload(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactKnownSecretText(value)
      .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
      .replace(
        /\b(?:sk-[A-Za-z0-9_-]{8,}|gsk_[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{20,}|sb_secret_[A-Za-z0-9_-]+|sb_publishable_[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g,
        '[REDACTED]',
      );
  }
  if (Array.isArray(value)) return value.map(redactCloudPayload);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        redactKnownSecretText(key),
        /authorization|api[-_]?key|password|token|secret/i.test(key)
          ? '[REDACTED]'
          : redactCloudPayload(item),
      ]),
    );
  }
  return value;
}
