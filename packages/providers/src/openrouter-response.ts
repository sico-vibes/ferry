/** OpenRouter's SDK requires a total even when the upstream only reports its components. */
export function normalizeOpenRouterUsage(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const chunk = value as Record<string, unknown>;
  if (!chunk.usage || typeof chunk.usage !== 'object' || Array.isArray(chunk.usage)) return value;
  const usage = chunk.usage as Record<string, unknown>;
  const input = usage.prompt_tokens;
  const output = usage.completion_tokens;
  if (
    usage.total_tokens != null ||
    typeof input !== 'number' ||
    typeof output !== 'number' ||
    !Number.isFinite(input) ||
    !Number.isFinite(output) ||
    input < 0 ||
    output < 0 ||
    !Number.isFinite(input + output)
  )
    return value;
  // Reasoning tokens are already included in completion_tokens.
  return { ...chunk, usage: { ...usage, total_tokens: input + output } };
}

function normalizeDataLine(line: string): string {
  if (!line.startsWith('data:')) return line;
  try {
    const value: unknown = JSON.parse(line.slice(5).trim());
    const normalized = normalizeOpenRouterUsage(value);
    return normalized === value ? line : `data: ${JSON.stringify(normalized)}`;
  } catch {
    // Keep DONE, malformed payloads and provider errors for the SDK to interpret.
    return line;
  }
}

/** Normalize SSE data incrementally; do not buffer an entire assistant reply. */
export function normalizeOpenRouterResponse(response: Response): Response {
  if (
    !response.ok ||
    !response.body ||
    !response.headers.get('content-type')?.includes('text/event-stream')
  )
    return response;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = '';
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(bytes, controller) {
        pending += decoder.decode(bytes, { stream: true });
        let newline: number;
        while ((newline = pending.indexOf('\n')) !== -1) {
          const line = pending.slice(0, newline);
          const crlf = line.endsWith('\r');
          controller.enqueue(
            encoder.encode(
              normalizeDataLine(crlf ? line.slice(0, -1) : line) + (crlf ? '\r\n' : '\n'),
            ),
          );
          pending = pending.slice(newline + 1);
        }
      },
      flush(controller) {
        pending += decoder.decode();
        if (pending) controller.enqueue(encoder.encode(normalizeDataLine(pending)));
      },
    }),
  );
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}
