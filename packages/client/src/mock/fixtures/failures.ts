import { FailureEntrySchema, type FailureEntry } from '@ferry/shared';

export function createFailures(now: Date, count = 3): FailureEntry[] {
  return Array.from({ length: count }, (_, index) =>
    FailureEntrySchema.parse({
      id: `mock-failure-${String(index)}`,
      at: new Date(now.getTime() - (count - index) * 60_000).toISOString(),
      providerId: 'groq',
      modelRef: 'groq/openai/gpt-oss-120b',
      keyId: 'groq:1',
      requestId: `mock-request-${String(index)}`,
      sessionId: null,
      source: 'agent',
      kind: 'server',
      statusCode: 502,
      message: '502 Upstream service error.',
      counted: 1,
    }),
  );
}
