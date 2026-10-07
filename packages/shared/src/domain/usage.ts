/** Preserve unknown reasoning counts; reasoning is already included in output tokens. */
export function reasoningTokensFromUsage(usage: unknown, metadata?: unknown): number | undefined {
  const record = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const input = record(usage);
  const details = record(input.outputTokenDetails ?? input.completion_tokens_details);
  const candidates = [
    input.reasoningTokens,
    input.reasoning,
    input.thoughtsTokenCount,
    details.reasoningTokens,
    details.reasoning_tokens,
  ];
  for (const provider of Object.values(record(metadata))) {
    const data = record(provider);
    candidates.push(data.reasoningTokens, data.thoughtsTokenCount);
    const providerUsage = record(data.usage ?? data.usageMetadata);
    candidates.push(providerUsage.reasoningTokens, providerUsage.thoughtsTokenCount);
    candidates.push(record(providerUsage.completion_tokens_details).reasoning_tokens);
  }
  return candidates.find(
    (value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0,
  );
}
